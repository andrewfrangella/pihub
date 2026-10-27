// pihub: one process that embeds the Node-RED runtime + editor, loads the hub flow,
// and registers the pihub nodes (nodes/). Run with `npm start`, open http://<pi>:1880
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const express = require('express');
const RED = require('node-red');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');                 // runtime state: live flows, ML datasets/models, logs
const PORT = Number(process.env.PIHUB_PORT || 1880);

// first run: seed the live flow from the shipped default
fs.mkdirSync(DATA, { recursive: true });
if (!fs.existsSync(path.join(DATA, 'flows.json'))) {
  fs.copyFileSync(path.join(ROOT, 'flows', 'hub-flow.json'), path.join(DATA, 'flows.json'));
  console.log('[pihub] seeded data/flows.json from flows/hub-flow.json');
}

const settings = require('./settings.js')({ root: ROOT, data: DATA });

const app = express();
const server = http.createServer(app);
RED.init(server, settings);
app.use(settings.httpAdminRoot, RED.httpAdmin);
app.use(settings.httpNodeRoot, RED.httpNode);

server.on('error', err => { console.error(`[pihub] cannot listen on port ${PORT}: ${err.code === 'EADDRINUSE' ? 'port in use' : err.message}`); process.exit(1); });
server.listen(PORT, () => console.log(`[pihub] editor at http://0.0.0.0:${PORT}${settings.httpAdminRoot}`));
RED.start().catch(err => { console.error('[pihub] failed to start', err); process.exit(1); });

let stopping = false;
function shutdown() {
  if (stopping) return; stopping = true;
  RED.stop().catch(err => console.error('[pihub] stop error', err && err.message)).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
