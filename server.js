const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = 3000;
const DB_PATH = path.join(__dirname, 'data', 'database.json');

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Helper: Read database
function readDB() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database:', error);
    return { users: [], requests: [], logs: [] };
  }
}

// Helper: Write database
function writeDB(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error writing database:', error);
    return false;
  }
}

// Helper: Generate unique ID
function generateID(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

// ============== AUTHENTICATION ==============

// Login API
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db = readDB();
  const user = db.users.find(u => u.username === username && u.password === password);

  if (user) {
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        role: user.role,
        email: user.email
      }
    });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// ============== STUDENT APIS ==============

// Create new request
app.post('/api/requests/create', (req, res) => {
  const { studentId, reason, expectedTime, duration } = req.body;

  if (!studentId || !reason || !expectedTime || !duration) {
    return res.status(400).json({ error: 'All fields required' });
  }

  const db = readDB();
  const student = db.users.find(u => u.id === studentId && u.role === 'student');

  if (!student) {
    return res.status(404).json({ error: 'Student not found' });
  }

  const newRequest = {
    id: generateID('REQ'),
    studentId,
    studentName: student.name,
    reason,
    expectedTime,
    duration,
    status: 'pending',
    createdAt: new Date().toISOString(),
    moderatorRemarks: null,
    qrCode: null,
    expiresAt: null
  };

  db.requests.push(newRequest);
  writeDB(db);

  res.json({ success: true, request: newRequest });
});

// Get student's requests
app.get('/api/requests/student/:studentId', (req, res) => {
  const { studentId } = req.params;
  const db = readDB();
  
  const requests = db.requests.filter(r => r.studentId === studentId);
  res.json({ requests });
});

// ============== MODERATOR APIS ==============

// Get all pending requests
app.get('/api/requests/pending', (req, res) => {
  const db = readDB();
  const pending = db.requests.filter(r => r.status === 'pending');
  res.json({ requests: pending });
});

// Get all requests (for moderator view)
app.get('/api/requests/all', (req, res) => {
  const db = readDB();
  res.json({ requests: db.requests });
});

// Approve request
app.post('/api/requests/approve', async (req, res) => {
  const { requestId, remarks } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: 'Request ID required' });
  }

  const db = readDB();
  const request = db.requests.find(r => r.id === requestId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request already processed' });
  }

  // Calculate expiry time
  const approvalTime = new Date();
  const expiryTime = new Date(approvalTime.getTime() + request.duration * 60 * 60 * 1000);

  // Generate QR data
  const qrData = {
    passId: request.id,
    studentId: request.studentId,
    studentName: request.studentName,
    reason: request.reason,
    approvedAt: approvalTime.toISOString(),
    expiresAt: expiryTime.toISOString(),
    used: false
  };

  try {
    // Generate QR code as data URL
    const qrCodeURL = await QRCode.toDataURL(JSON.stringify(qrData));

    request.status = 'approved';
    request.moderatorRemarks = remarks || 'Approved';
    request.approvedAt = approvalTime.toISOString();
    request.expiresAt = expiryTime.toISOString();
    request.qrCode = qrCodeURL;
    request.qrData = qrData;

    writeDB(db);

    res.json({ success: true, request });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

// Reject request
app.post('/api/requests/reject', (req, res) => {
  const { requestId, reason } = req.body;

  if (!requestId || !reason) {
    return res.status(400).json({ error: 'Request ID and reason required' });
  }

  const db = readDB();
  const request = db.requests.find(r => r.id === requestId);

  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }

  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request already processed' });
  }

  request.status = 'rejected';
  request.rejectionReason = reason;
  request.rejectedAt = new Date().toISOString();

  writeDB(db);

  res.json({ success: true, request });
});

// ============== GATEKEEPER APIS ==============

// Verify QR code
app.post('/api/qr/verify', (req, res) => {
  const { qrData } = req.body;

  if (!qrData) {
    return res.status(400).json({ error: 'QR data required' });
  }

  let parsedData;
  try {
    parsedData = JSON.parse(qrData);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid QR data format' });
  }

  const db = readDB();
  const request = db.requests.find(r => r.id === parsedData.passId);

  if (!request) {
    return res.json({ 
      valid: false, 
      message: 'Pass not found',
      color: 'red'
    });
  }

  if (request.status !== 'approved') {
    return res.json({ 
      valid: false, 
      message: 'Pass not approved',
      color: 'red'
    });
  }

  if (parsedData.used) {
    return res.json({ 
      valid: false, 
      message: 'Pass already used',
      color: 'red'
    });
  }

  const now = new Date();
  const expiryTime = new Date(parsedData.expiresAt);

  if (now > expiryTime) {
    return res.json({ 
      valid: false, 
      message: 'Pass expired',
      color: 'red',
      details: parsedData
    });
  }

  res.json({ 
    valid: true, 
    message: 'Valid pass',
    color: 'green',
    details: parsedData
  });
});

// Log entry/exit
app.post('/api/logs/entry', (req, res) => {
  const { passId, type, qrData } = req.body;

  if (!passId || !type) {
    return res.status(400).json({ error: 'Pass ID and type required' });
  }

  const db = readDB();
  const request = db.requests.find(r => r.id === passId);

  if (!request) {
    return res.status(404).json({ error: 'Pass not found' });
  }

  // Mark QR as used
  if (request.qrData) {
    request.qrData.used = true;
  }

  const logEntry = {
    id: generateID('LOG'),
    passId,
    studentId: request.studentId,
    studentName: request.studentName,
    type, // 'entry' or 'exit'
    timestamp: new Date().toISOString(),
    reason: request.reason
  };

  db.logs.push(logEntry);
  writeDB(db);

  res.json({ success: true, log: logEntry });
});

// ============== ADMIN APIS ==============

// Get all logs
app.get('/api/logs/all', (req, res) => {
  const db = readDB();
  res.json({ logs: db.logs });
});

// Get dashboard statistics
app.get('/api/admin/stats', (req, res) => {
  const db = readDB();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const stats = {
    totalRequests: db.requests.length,
    pendingRequests: db.requests.filter(r => r.status === 'pending').length,
    approvedToday: db.requests.filter(r => {
      if (r.status === 'approved' && r.approvedAt) {
        const approvedDate = new Date(r.approvedAt);
        return approvedDate >= today;
      }
      return false;
    }).length,
    rejectedToday: db.requests.filter(r => {
      if (r.status === 'rejected' && r.rejectedAt) {
        const rejectedDate = new Date(r.rejectedAt);
        return rejectedDate >= today;
      }
      return false;
    }).length,
    totalLogs: db.logs.length,
    entryLogsToday: db.logs.filter(l => {
      const logDate = new Date(l.timestamp);
      return logDate >= today && l.type === 'entry';
    }).length
  };

  res.json(stats);
});

// Get all users
app.get('/api/admin/users', (req, res) => {
  const db = readDB();
  const users = db.users.map(u => ({
    id: u.id,
    name: u.name,
    username: u.username,
    role: u.role,
    email: u.email
  }));
  res.json({ users });
});

// Export reports (simplified - returns JSON, frontend can convert to CSV)
app.get('/api/admin/export', (req, res) => {
  const db = readDB();
  const { type } = req.query; // 'requests' or 'logs'

  if (type === 'logs') {
    res.json({ data: db.logs });
  } else {
    res.json({ data: db.requests });
  }
});

// ============== START SERVER ==============

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📝 API Endpoints:');
  console.log('   POST /api/login');
  console.log('   POST /api/requests/create');
  console.log('   GET  /api/requests/student/:studentId');
  console.log('   GET  /api/requests/pending');
  console.log('   POST /api/requests/approve');
  console.log('   POST /api/requests/reject');
  console.log('   POST /api/qr/verify');
  console.log('   POST /api/logs/entry');
  console.log('   GET  /api/admin/stats');
});