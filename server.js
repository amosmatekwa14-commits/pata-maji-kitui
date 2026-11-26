require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const CONSUMER_KEY = process.env.CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET;
const SHORTCODE = process.env.SHORTCODE || process.env.MPESA_SHORTCODE || "8510175";
const TILL_NUMBER = process.env.TILL_NUMBER || "6139178";
const PASSKEY = process.env.PASSKEY || process.env.MPESA_PASSKEY;
const CALLBACK_URL = process.env.CALLBACK_URL || "https://pata-maji-kitui.onrender.com/api/callback";
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Kitui123";
const BASE_URL = "https://api.safaricom.co.ke";

// --- GITHUB SYNC - makes Admin delete PERMANENT on Free Render ---
// Set these 2 in Render > Environment:
// GITHUB_TOKEN = your GitHub Personal Access Token (contents: write)
// GITHUB_REPO = yourusername/pata-maji-kitui  e.g. amos123/pata-maji-kitui
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || "";
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";

let adminToken = null;

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
function guessCat(name){
  const n = String(name).toLowerCase();
  if(n.includes('fresh') || n.includes('salty')) return 'daily';
  if(n.includes('bulk') || n.includes('bowser')) return 'bulk';
  if(n.includes('bottled') || n.includes('pack')) return 'bottled';
  return 'refill';
}
let SETTINGS = {
  minDailyQty: 3,
  prices: {
    '20L Fresh Water': 30,
    '20L Salty Water': 25,
    '20L Refill': 150,
    '20L Bottle + Water Refill': 850,
    '10L Refill': 100,
    '10L Soft Bottle + Water Refill': 220,
    '10L Hard Bottle + Water Refill': 440,
    '24 Pack 500ml Bottled': 400,
    '5000L Bulk (Charged Based on Distance)': 3000,
    '6000L Bulk (Charged Based on Distance)': 4500,
    '10000L Bulk (Charged Based on Distance)': 6500,
  },
  categories: {
    '20L Fresh Water': 'daily',
    '20L Salty Water': 'daily',
    '20L Refill': 'refill',
    '20L Bottle + Water Refill': 'refill',
    '10L Refill': 'refill',
    '10L Soft Bottle + Water Refill': 'refill',
    '10L Hard Bottle + Water Refill': 'refill',
    '24 Pack 500ml Bottled': 'bottled',
    '5000L Bulk (Charged Based on Distance)': 'bulk',
    '6000L Bulk (Charged Based on Distance)': 'bulk',
    '10000L Bulk (Charged Based on Distance)': 'bulk',
  }
};
try{
  if(fs.existsSync(SETTINGS_FILE)){
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8'));
    SETTINGS = { ...SETTINGS, ...saved, prices: saved.prices || SETTINGS.prices, categories: saved.categories || {} };
    Object.keys(SETTINGS.prices).forEach(n=>{ if(!SETTINGS.categories[n]) SETTINGS.categories[n] = guessCat(n); });
    Object.keys(SETTINGS.categories).forEach(n=>{ if(!SETTINGS.prices[n]) delete SETTINGS.categories[n]; });
  }
}catch(e){}

// Push settings.json to GitHub so it survives Render restart on Free plan
async function pushSettingsToGitHub(){
  if(!GITHUB_TOKEN || !GITHUB_REPO) return { ok:false, reason:'no-github-token' };
  try{
    const content = Buffer.from(JSON.stringify(SETTINGS,null,2)).toString('base64');
    let sha = null;
    try{
      const getRes = await axios.get(`https://api.github.com/repos/${GITHUB_REPO}/contents/settings.json?ref=${GITHUB_BRANCH}`, { headers:{ Authorization:`Bearer ${GITHUB_TOKEN}`, Accept:'application/vnd.github+json' } });
      sha = getRes.data.sha;
    }catch(e){ sha = null; }
    const body = { message:'Update settings from Admin - ' + new Date().toISOString(), content, branch: GITHUB_BRANCH };
    if(sha) body.sha = sha;
    await axios.put(`https://api.github.com/repos/${GITHUB_REPO}/contents/settings.json`, body, { headers:{ Authorization:`Bearer ${GITHUB_TOKEN}`, Accept:'application/vnd.github+json' } });
    console.log('✅ settings.json pushed to GitHub');
    return { ok:true };
  }catch(e){ console.error('GitHub push failed:', e.response?.data || e.message); return { ok:false, reason: e.message }; }
}
function saveSettings(){ try{ fs.writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS,null,2)); }catch(e){} pushSettingsToGitHub(); }
const PRICES = SETTINGS.prices;

function isDailyUse(product){
  if(SETTINGS.categories && SETTINGS.categories[product]) return SETTINGS.categories[product] === 'daily';
  return product === '20L Fresh Water' || product === '20L Salty Water';
}
function validateOrder(product, qty, amount){
  const price = SETTINGS.prices[product];
  if(!price) return { ok: true };
  qty = Number(qty) || 1;
  if(isDailyUse(product) && qty < SETTINGS.minDailyQty){
    return { ok: false, error: 'Daily Use minimum order is ' + SETTINGS.minDailyQty + ' jerrycans. You ordered ' + qty + '.' };
  }
  const expected = price * qty;
  if(Number(amount) !== expected){
    return { ok: false, error: `Wrong amount. ${product} x ${qty} should be KSh ${expected}, not KSh ${amount}.` };
  }
  return { ok: true, price, expected };
}

const ORDERS_FILE = path.join(__dirname, 'orders.json');
let payments = [];
try{ if(fs.existsSync(ORDERS_FILE)) payments = JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8')); }catch(e){ payments=[]; }
function savePayments(){ try{ fs.writeFileSync(ORDERS_FILE, JSON.stringify(payments,null,2)); }catch(e){} }

function checkAdmin(req, res, next){
  const token = req.headers['x-admin-token'];
  if(token && token === adminToken) next();
  else res.status(401).json({ success: false, error: "Not authorized. Please login." });
}

async function getToken() {
  const auth = Buffer.from(`${CONSUMER_KEY}:${CONSUMER_SECRET}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` }
  });
  return res.data.access_token;
}
function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function querySTK(checkoutId) {
  try {
    const token = await getToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');
    const res = await axios.post(`${BASE_URL}/mpesa/stkpushquery/v1/query`, {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutId
    }, { headers: { Authorization: `Bearer ${token}` } });
    return res.data;
  } catch (e) { return null; }
}

app.get('/api/settings', (req, res) => res.json({ success: true, settings: SETTINGS }));
app.get('/api/prices', (req, res) => res.json({ success: true, prices: SETTINGS.prices }));

app.post('/api/admin/settings', checkAdmin, async (req, res) => {
  const { minDailyQty, prices, categories } = req.body;
  if(minDailyQty !== undefined) SETTINGS.minDailyQty = Number(minDailyQty);
  if(prices) SETTINGS.prices = prices;
  if(categories) SETTINGS.categories = categories;
  Object.keys(SETTINGS.prices).forEach(n=>{ if(!SETTINGS.categories[n]) SETTINGS.categories[n] = guessCat(n); });
  Object.keys(SETTINGS.categories).forEach(n=>{ if(!SETTINGS.prices[n]) delete SETTINGS.categories[n]; });
  saveSettings();
  const pushed = await pushSettingsToGitHub();
  res.json({ success: true, settings: SETTINGS, githubSaved: pushed.ok });
});

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if(password === ADMIN_PASSWORD){
    adminToken = 'patamaji-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    res.json({ success: true, token: adminToken });
  } else { res.status(401).json({ success: false, error: "Wrong password" }); }
});
app.post('/api/admin/logout', (req, res) => { adminToken = null; res.json({ success: true }); });

app.post('/stk-push', async (req, res) => {
  try {
    let { phone, amount, name, location, houseNo, notes, product, qty } = req.body;
    phone = String(phone).replace(/\s/g, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (phone.startsWith('+')) phone = phone.slice(1);
    let qtyNum = Number(qty);
    if(!qtyNum || qtyNum < 1){
      const p = SETTINGS.prices[product];
      qtyNum = p ? Math.round(Number(amount) / p) : 1;
      if(!qtyNum || qtyNum < 1) qtyNum = 1;
    }
    const check = validateOrder(product, qtyNum, Number(amount));
    if(!check.ok){
      return res.status(400).json({ success: false, error: { errorMessage: check.error } });
    }
    const token = await getToken();
    const timestamp = getTimestamp();
    const password = Buffer.from(SHORTCODE + PASSKEY + timestamp).toString('base64');
    const payload = {
      BusinessShortCode: SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerBuyGoodsOnline",
      Amount: Number(amount),
      PartyA: phone,
      PartyB: TILL_NUMBER,
      PhoneNumber: phone,
      CallBackURL: CALLBACK_URL,
      AccountReference: "PATA MAJI KITUI",
      TransactionDesc: `Water - ${location||''} H${houseNo||''}`
    };
    const response = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${token}` }
    });
    payments.unshift({
      time: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      id: Date.now(),
      phone: phone, amount: Number(amount), status: "PENDING", receipt: "",
      checkoutId: response.data.CheckoutRequestID || "",
      name: name || '', location: location || '', houseNo: houseNo || '',
      notes: notes || '', product: product || '', qty: qtyNum,
      address: `${location||''}, House no: ${houseNo||''}`,
      source: 'STK'
    });
    savePayments();
    res.json({ success: true, data: response.data });
  } catch (err) {
    console.error("STK ERROR:", JSON.stringify(err.response?.data, null, 2));
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.post('/api/whatsapp-order', (req, res) => {
  const { name, phone, location, houseNo, notes, product, qty, amount } = req.body;
  const check = validateOrder(product, qty, Number(amount));
  if(!check.ok) return res.status(400).json({ success: false, error: check.error });
  const order = {
    time: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    id: Date.now(),
    checkoutId: 'WA-' + Date.now(),
    name: name || '', phone: String(phone||''), amount: Number(amount||0),
    product: product || '', qty: Number(qty)||1,
    location: location || '', houseNo: houseNo || '', notes: notes || '',
    address: `${location||''}, House no: ${houseNo||''}`,
    status: 'WHATSAPP_ORDER',
    source: 'WhatsApp',
    receipt: '-'
  };
  payments.unshift(order);
  savePayments();
  console.log('📱 WhatsApp order saved:', order);
  res.json({ success: true, order });
});

app.post('/api/orders/:id/paid', (req, res) => {
  const id = req.params.id;
  const pay = payments.find(p => String(p.checkoutId)===String(id) || String(p.id)===String(id));
  if(!pay) return res.json({ success:false, message:'Order not found' });
  pay.status = 'PAID';
  savePayments();
  res.json({ success:true, order: pay });
});

app.get('/api/check-payment/:checkoutId', async (req, res) => {
  const checkoutId = req.params.checkoutId;
  const pay = payments.find(p => p.checkoutId === checkoutId);
  if (!pay) return res.json({ status: "NOT_FOUND" });
  if (pay.status !== "PENDING") return res.json({ status: pay.status, receipt: pay.receipt, amount: pay.amount });
  const result = await querySTK(checkoutId);
  if (result) {
    const code = String(result.ResultCode);
    if (code === "0") { pay.status = "PAID"; pay.receipt = result.MpesaReceiptNumber || pay.receipt || "PAID"; savePayments(); }
    else if (code === "1032" || code === "1037") { pay.status = "FAILED"; savePayments(); }
  }
  res.json({ status: pay.status, receipt: pay.receipt, amount: pay.amount, raw: result });
});

function handleCallback(req,res){
  const stk = req.body?.Body?.stkCallback;
  if (stk) {
    const checkoutId = stk.CheckoutRequestID;
    const resultCode = stk.ResultCode;
    const items = stk.CallbackMetadata?.Item || [];
    const getVal = (name) => { const f = items.find(i => i.Name === name); return f ? f.Value : ""; };
    const receipt = getVal("MpesaReceiptNumber");
    const amount = getVal("Amount");
    const phone = getVal("PhoneNumber");
    const pay = payments.find(p => p.checkoutId === checkoutId);
    if (pay) {
      if (resultCode === 0) { pay.status = "PAID"; pay.receipt = receipt; pay.amount = amount || pay.amount; pay.phone = String(phone) || pay.phone; }
      else { pay.status = "FAILED"; }
      savePayments();
    } else {
      payments.unshift({ time: new Date().toISOString(), phone: String(phone||""), amount: Number(amount||0), status: resultCode===0?"PAID":"FAILED", receipt: receipt||"", checkoutId });
      savePayments();
    }
  }
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}
app.post('/callback', handleCallback);
app.post('/api/callback', handleCallback);

app.get('/api/orders', (req, res) => {
  const sorted = [...payments].sort((a,b)=>{
    const rank = s => s==='PAID'?0 : s==='PENDING'?1 : 2;
    return rank(a.status)-rank(b.status) || new Date(b.time)-new Date(a.time);
  });
  res.json(sorted);
});
app.post('/api/orders/:id/delivered', (req, res) => {
  const id = req.params.id;
  const pay = payments.find(p=> String(p.checkoutId)===String(id) || String(p.receipt)===String(id) || String(p.id)===String(id));
  if(!pay) return res.json({success:false, message:'Order not found'});
  pay.status = 'DELIVERED'; pay.deliveredAt = new Date().toISOString(); savePayments();
  res.json({success:true, order: pay});
});
app.post('/api/test-order', (req,res)=>{
  const o = { time:new Date().toISOString(), createdAt:new Date().toISOString(), id:Date.now(), checkoutId:'TEST'+Date.now(), name:req.body.name||'Mutua', phone:req.body.phone||'0768814375', amount:req.body.amount||60, product:req.body.product||'20L Fresh Water', qty:2, location:req.body.location||'NDELI', houseNo:req.body.houseNo||'H1', notes:req.body.notes||'Blue gate', address:'NDELI, House no: H1', status:'PAID', receipt:'QKTEST'+Math.floor(Math.random()*100000) };
  payments.unshift(o); savePayments(); res.json({success:true, order:o});
});

app.get('/api/admin/payments', checkAdmin, (req, res) => {
  const today = new Date().toDateString();
  const isSale = p => p.status === 'PAID' || p.status === 'DELIVERED';
  const todayPayments = payments.filter(p => new Date(p.time).toDateString() === today && isSale(p));
  const todaySales = todayPayments.reduce((sum, p) => sum + Number(p.amount), 0);
  const totalSales = payments.filter(isSale).reduce((sum, p) => sum + Number(p.amount), 0);
  res.json({
    payments: payments,
    stats: { todaySales, todayCount: todayPayments.length, totalSales, totalCount: payments.filter(isSale).length, pendingCount: payments.filter(p => p.status==='PENDING').length }
  });
});

app.get('/api/health', (req,res)=> res.json({ok:true, mode:'PRODUCTION', shortcode: SHORTCODE, till: TILL_NUMBER, base: BASE_URL, orders: payments.length}));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin-settings', (req, res) => res.sendFile(path.join(__dirname, 'admin-settings.html')));
app.get('/admin-login', (req, res) => res.sendFile(path.join(__dirname, 'admin-login.html')));
app.get('/delivery', (req,res)=> res.sendFile(path.join(__dirname, 'delivery.html')));

app.listen(PORT, () => console.log(`Server on http://localhost:${PORT} - SHORTCODE ${SHORTCODE} TILL ${TILL_NUMBER} PRODUCTION`));
