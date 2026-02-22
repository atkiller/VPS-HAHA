/**
 * VPS Web Panel - server.js
 * Browser-based SSH terminal + SFTP file manager
 * Protected by email/password login
 */

const express = require('express');
const session = require('express-session');
const http = require('http');
const WebSocket = require('ws');
const { Client } = require('ssh2');
const path = require('path');
const multer = require('multer');
const os = require('os');

const app = express();
const server = http.createServer(app);

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  // Panel login credentials
  EMAIL: 'ayushtewariat@gmail.com',
  PASSWORD: '30123012',
  SESSION_SECRET: 'vps-panel-secret-key-2024',
  // SSH connection to THIS server (localhost)
  SSH: {
    host: '127.0.0.1',
    port: 22,
    username: process.env.SSH_USER || os.userInfo().username,
    // Set one of: password OR privateKeyPath
    password: process.env.SSH_PASS || '',
    privateKeyPath: process.env.SSH_KEY || path.join(os.homedir(), '.ssh', 'id_rsa'),
  }
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 86400000 } // 24h
}));
app.use('/public', express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: os.tmpdir() });

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

// ─── HTTP ROUTES ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (email === CONFIG.EMAIL && password === CONFIG.PASSWORD) {
    req.session.authenticated = true;
    req.session.user = email;
    return res.json({ success: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/status', requireAuth, (req, res) => {
  const fs = require('fs');
  const cpuCount = os.cpus().length;
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeMem  = (os.freemem()  / 1024 / 1024 / 1024).toFixed(2);
  const usedMem  = (totalMem - freeMem).toFixed(2);
  const uptime   = os.uptime();
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuCount,
    totalMem: totalMem + ' GB',
    usedMem:  usedMem  + ' GB',
    freeMem:  freeMem  + ' GB',
    memPercent: Math.round((usedMem / totalMem) * 100),
    uptime: formatUptime(uptime),
    loadAvg: os.loadavg().map(l => l.toFixed(2)).join(' / ')
  });
});

// ─── SFTP REST API ────────────────────────────────────────────────────────────
function sshConnect(cb) {
  const fs = require('fs');
  const conn = new Client();
  const sshOpts = {
    host:     CONFIG.SSH.host,
    port:     CONFIG.SSH.port,
    username: CONFIG.SSH.username,
  };

  if (CONFIG.SSH.password) {
    sshOpts.password = CONFIG.SSH.password;
  } else {
    try {
      sshOpts.privateKey = fs.readFileSync(CONFIG.SSH.privateKeyPath);
    } catch (e) {
      // fallback: try agent
      sshOpts.agent = process.env.SSH_AUTH_SOCK;
    }
  }

  conn.on('ready', () => cb(null, conn))
      .on('error', (e) => cb(e, null))
      .connect(sshOpts);
}

// List directory
app.get('/api/sftp/list', requireAuth, (req, res) => {
  const dir = req.query.path || '/';
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      sftp.readdir(dir, (err, list) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        const items = list.map(f => ({
          name: f.filename,
          type: f.attrs.isDirectory() ? 'dir' : 'file',
          size: f.attrs.size,
          modified: new Date(f.attrs.mtime * 1000).toISOString(),
          permissions: f.attrs.mode ? (f.attrs.mode & 0o777).toString(8).padStart(4,'0') : '----',
        })).sort((a,b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        res.json({ path: dir, items });
      });
    });
  });
});

// Download file
app.get('/api/sftp/download', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      const stream = sftp.createReadStream(filePath);
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
      stream.on('close', () => conn.end());
      stream.on('error', (e) => { conn.end(); res.status(500).end(); });
      stream.pipe(res);
    });
  });
});

// Upload file
app.post('/api/sftp/upload', requireAuth, upload.single('file'), (req, res) => {
  const fs = require('fs');
  const remotePath = path.join(req.body.path || '/', req.file.originalname);
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      const readStream  = fs.createReadStream(req.file.path);
      const writeStream = sftp.createWriteStream(remotePath);
      writeStream.on('close', () => {
        fs.unlink(req.file.path, ()=>{});
        conn.end();
        res.json({ success: true, path: remotePath });
      });
      writeStream.on('error', (e) => { conn.end(); res.status(500).json({ error: e.message }); });
      readStream.pipe(writeStream);
    });
  });
});

// Delete
app.delete('/api/sftp/delete', requireAuth, (req, res) => {
  const { path: filePath, type } = req.body;
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      const del = type === 'dir' ? sftp.rmdir.bind(sftp) : sftp.unlink.bind(sftp);
      del(filePath, (err) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

// Create directory
app.post('/api/sftp/mkdir', requireAuth, (req, res) => {
  const { path: dirPath } = req.body;
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      sftp.mkdir(dirPath, (err) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

// Rename
app.post('/api/sftp/rename', requireAuth, (req, res) => {
  const { from, to } = req.body;
  sshConnect((err, conn) => {
    if (err) return res.status(500).json({ error: err.message });
    conn.sftp((err, sftp) => {
      if (err) { conn.end(); return res.status(500).json({ error: err.message }); }
      sftp.rename(from, to, (err) => {
        conn.end();
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    });
  });
});

// ─── WEBSOCKET SSH TERMINAL ───────────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/ws/ssh' });

wss.on('connection', (ws, req) => {
  // Validate session cookie
  // Simple approach: clients send an auth token in first message
  let authenticated = false;
  let sshConn = null;
  let stream  = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);

      // First message must be auth
      if (!authenticated) {
        if (msg.type === 'auth' && msg.token === CONFIG.PASSWORD) {
          authenticated = true;
          ws.send(JSON.stringify({ type: 'status', text: 'Connecting to SSH...' }));
          startSSH();
        } else {
          ws.send(JSON.stringify({ type: 'error', text: 'Unauthorized' }));
          ws.close();
        }
        return;
      }

      if (msg.type === 'input' && stream) {
        stream.write(msg.data);
      } else if (msg.type === 'resize' && stream) {
        stream.setWindow(msg.rows, msg.cols, 0, 0);
      }
    } catch (e) {
      // raw input fallback
      if (authenticated && stream) stream.write(data);
    }
  });

  ws.on('close', () => {
    if (sshConn) sshConn.end();
  });

  function startSSH() {
    const fs = require('fs');
    sshConn = new Client();
    const sshOpts = {
      host:     CONFIG.SSH.host,
      port:     CONFIG.SSH.port,
      username: CONFIG.SSH.username,
    };
    if (CONFIG.SSH.password) {
      sshOpts.password = CONFIG.SSH.password;
    } else {
      try {
        sshOpts.privateKey = fs.readFileSync(CONFIG.SSH.privateKeyPath);
      } catch (e) {
        sshOpts.agent = process.env.SSH_AUTH_SOCK;
      }
    }

    sshConn.on('ready', () => {
      ws.send(JSON.stringify({ type: 'status', text: 'Connected!' }));
      sshConn.shell({ term: 'xterm-256color', rows: 24, cols: 80 }, (err, s) => {
        if (err) {
          ws.send(JSON.stringify({ type: 'error', text: err.message }));
          return ws.close();
        }
        stream = s;
        stream.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: d.toString('base64') }));
          }
        });
        stream.on('close', () => {
          ws.send(JSON.stringify({ type: 'exit', text: 'Session closed.' }));
          ws.close();
        });
        stream.stderr.on('data', (d) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: d.toString('base64') }));
          }
        });
      });
    });

    sshConn.on('error', (err) => {
      ws.send(JSON.stringify({ type: 'error', text: 'SSH Error: ' + err.message }));
      ws.close();
    });

    sshConn.connect(sshOpts);
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function formatUptime(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

// ─── START ────────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log(`\n🚀 VPS Panel running at http://localhost:${CONFIG.PORT}`);
  console.log(`📧 Login: ${CONFIG.EMAIL}`);
  console.log(`🔑 Password: ${CONFIG.PASSWORD}`);
  console.log(`\n⚙️  SSH Config:`);
  console.log(`   Host: ${CONFIG.SSH.host}:${CONFIG.SSH.port}`);
  console.log(`   User: ${CONFIG.SSH.username}`);
  console.log(`\nSet SSH_PASS env var or ensure SSH key exists at ${CONFIG.SSH.privateKeyPath}`);
});
