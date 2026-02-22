# ⚡ VPS Web Panel

A beautiful, browser-based VPS management panel with:
- **SSH Terminal** — full interactive shell in the browser
- **SFTP File Manager** — browse, upload, download, rename, delete files
- **Server Overview** — live CPU, RAM, uptime stats
- **Login Protection** — email + password authentication

---

## 🚀 Quick Setup on Your VPS

### 1. Install Node.js (if not already)
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs
```

### 2. Upload these files to your VPS
```bash
scp -r vps-panel/ user@YOUR_VPS_IP:/opt/vps-panel
```

### 3. Install dependencies
```bash
cd /opt/vps-panel
npm install
```

### 4. Configure SSH credentials

Edit `server.js` → find the `CONFIG` section:

```js
SSH: {
  host: '127.0.0.1',
  port: 22,
  username: 'your-linux-username',
  password: 'your-ssh-password',   // OR leave blank to use SSH key
  privateKeyPath: '/root/.ssh/id_rsa',
}
```

**Option A — SSH Password:**
```bash
SSH_PASS=your_ssh_pass node server.js
```

**Option B — SSH Key (recommended):**  
Make sure `/root/.ssh/id_rsa` exists (default), or set `SSH_KEY` env var.

**Option C — Edit server.js directly:**  
Set `password: 'your-ssh-password'` inside CONFIG.SSH

### 5. Start the panel
```bash
node server.js
# or with PM2 (persistent):
npm install -g pm2
pm2 start server.js --name vps-panel
pm2 save && pm2 startup
```

### 6. Access the panel
Open: **http://YOUR_VPS_IP:3000**

Login with:
- **Email:** `ayushtewariat@gmail.com`
- **Password:** `30123012`

---

## 🔒 Security Recommendations

1. **Use a reverse proxy** (Nginx + SSL):
```nginx
server {
  listen 443 ssl;
  server_name panel.yourdomain.com;
  
  ssl_certificate /etc/letsencrypt/live/panel.yourdomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/panel.yourdomain.com/privkey.pem;
  
  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

2. **Use SSH key** instead of password for SSH connection
3. **Change the PORT** from 3000 to something less obvious
4. **Firewall**: Only allow port 3000 from your IP if needed

---

## 📁 Project Structure
```
vps-panel/
├── server.js          # Main server (Express + WebSocket)
├── package.json
├── README.md
└── public/
    └── index.html     # Full frontend UI
```

---

## 🛠️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Panel HTTP port |
| `SSH_USER` | current user | Linux username for SSH |
| `SSH_PASS` | (empty) | SSH password |
| `SSH_KEY` | ~/.ssh/id_rsa | Path to SSH private key |
