// Node-RED runtime settings for pihub. See https://nodered.org/docs/user-guide/runtime/configuration
'use strict';
const path = require('path');

module.exports = ({ root, data }) => ({
  httpAdminRoot: '/',          // the editor
  httpNodeRoot: '/api',        // endpoints created by http-in nodes, if any
  userDir: data,
  flowFile: 'flows.json',
  flowFilePretty: true,
  nodesDir: path.join(root, 'nodes'),      // pihub's own nodes
  credentialSecret: false,                 // no credential encryption prompt on first start

  // trim the palette to what a performance hub needs (file names under @node-red/nodes/core)
  nodesExcludes: [
    '05-tls.js', '06-httpproxy.js', '10-mqtt.js', '21-httpin.js', '21-httprequest.js',
    '22-websocket.js', '31-tcpin.js', '70-HTML.js', '70-XML.js', '70-YAML.js', '90-exec.js',
  ],

  logging: { console: { level: 'info', metrics: false, audit: false } },
  diagnostics: { enabled: true, ui: false },
  runtimeState: { enabled: false, ui: false },
  contextStorage: { default: { module: 'memory' } },
  functionExternalModules: false,
  externalModules: { palette: { allowInstall: true } },   // keep the palette manager so @flowfuse/node-red-dashboard can be added later
  functionGlobalContext: {},
  exportGlobalContextKeys: false,

  editorTheme: {
    page:   { title: 'pihub' },
    header: { title: 'pihub', image: null, url: null },
    deployButton: { type: 'simple', label: 'Deploy' },
    projects: { enabled: false },
    tours: false,
    palette: {
      categories: ['pihub', 'common', 'function', 'network', 'sequence', 'parser', 'storage'],
    },
    menu: { 'menu-item-help': false, 'menu-item-node-red-version': false },
    codeEditor: { lib: 'monaco' },
  },
});
