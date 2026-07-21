const { draft, option, argv } = require('draft');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');

console.log = console.error; // stdout is the stdio JSON-RPC channel, so all logging (incl. run()'s "ok mcp") goes to stderr

option('port', 'HTTP port; omit to use stdio', { default: null });

draft('mcp', 'start the MCP server', () => {
  const file = path.join(process.cwd(), '.mcp.json');
  if (!fs.existsSync(file)) throw new Error('.mcp.json not found'); // surfaces via run() as a failed task
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));

  const draftCli = (taskFile, ...args) => {
    try {
      return execFileSync('node', [path.join(process.cwd(), taskFile), ...args],
        { env: { ...process.env, DRAFT_FORMAT: 'json' } }).toString().trim();
    } catch (e) {
      return e.stdout ? e.stdout.toString().trim() : ''; // a failed task exits non-zero but still printed its report
    }
  };

  const listTool = (tool) => {
    const { tasks, options } = JSON.parse(draftCli(tool.file)); // JSON, not help text, so layout changes can't break it
    return {
      name: tool.name, description: tool.description,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', enum: tasks.map((t) => t.name), description: 'which task to run' },
          ...Object.fromEntries(options.map((o) => [o.name, { type: o.type, description: o.desc }])),
        },
        required: ['task'],
      },
    };
  };

  const byTool = Object.fromEntries(manifest.tools.map((t) => [t.name, t]));

  const callTool = (name, args) => {
    const { task, ...rest } = args;
    const flags = Object.entries(rest).flatMap(([k, v]) => (v === false ? [] : [`--${k}`, `${v}`])); // skip false: `--flag false` would parse as true
    const stdout = draftCli(byTool[name].file, task, ...flags);
    // last line is the top-level task's JSON report; if the child printed nothing parseable, treat as an error
    let status; try { status = JSON.parse(stdout.split('\n').pop()).status; } catch { status = 'error'; }
    return { content: [{ type: 'text', text: stdout || `task '${task}' produced no output` }], isError: status === 'error' };
  };

  const resources = manifest.resources || [];
  const uriOf = (r) => `file://${path.join(process.cwd(), r.file)}`;

  const result = (msg) => {
    const p = msg.params || {};
    if (msg.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {} }, serverInfo: manifest.server, instructions: manifest.instructions }; // instructions: context the client loads up-front
    if (msg.method === 'tools/list') return { tools: manifest.tools.map(listTool) };
    if (msg.method === 'tools/call') {
      if (!byTool[p.name]) throw new Error(`unknown tool: ${p.name}`);
      return callTool(p.name, p.arguments || {});
    }
    if (msg.method === 'resources/list') return { resources: resources.map((r) => ({ uri: uriOf(r), name: r.name, description: r.description, mimeType: 'text/plain' })) };
    if (msg.method === 'resources/read') {
      const r = resources.find((x) => uriOf(x) === p.uri);
      if (!r) throw new Error(`unknown resource: ${p.uri}`);
      return { contents: [{ uri: p.uri, mimeType: 'text/plain', text: fs.readFileSync(path.join(process.cwd(), r.file), 'utf8') }] };
    }
    throw Object.assign(new Error(`method not found: ${msg.method}`), { code: -32601 });
  };

  // always return a valid JSON-RPC envelope; a thrown handler becomes an error response, never a crash
  const handle = (msg) => {
    try { return { jsonrpc: '2.0', id: msg.id, result: result(msg) }; }
    catch (e) { return { jsonrpc: '2.0', id: msg.id ?? null, error: { code: e.code || -32603, message: e.message } }; }
  };

  const port = argv().port;
  if (port) {
    require('http').createServer(mcpAuthRouter(manifest.auth, (req, res) => {
      if (req.url !== '/mcp' || req.method !== 'POST') return res.writeHead(405).end();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let msg;
        try { msg = JSON.parse(body); } catch { return res.writeHead(400).end(); }
        if (msg.id === undefined) return res.writeHead(202).end();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(handle(msg)));
      });
    })).listen(port);
    return { transport: 'http', port, auth: manifest.auth?.issuer ? 'on' : 'off', tools: manifest.tools.length };
  }
  require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore a malformed line instead of crashing
    if (msg.id === undefined) return; // notifications get no response on stdio
    process.stdout.write(JSON.stringify(handle(msg)) + '\n');
  });
  return { transport: 'stdio', tools: manifest.tools.length };
});

// Wraps an http handler with OIDC bearer auth so the handler stays pure MCP (RFC 9728).
// A function declaration so it hoists above its call site inside draft('mcp').
function mcpAuthRouter(auth, handler) {
  if (!auth?.issuer) return handler;
  const { issuer } = auth;
  const getJSON = (url) => new Promise((resolve, reject) => {
    require(url.startsWith('https') ? 'https' : 'http').get(url, (r) => {
      let b = ''; r.on('data', (c) => (b += c));
      r.on('end', () => r.statusCode === 200 ? resolve(JSON.parse(b)) : reject(new Error(`${url} -> HTTP ${r.statusCode}`)));
    }).on('error', reject);
  });
  let keys = []; // JWKS cache
  const keyFor = async (kid) => {
    if (!keys.some((k) => k.kid === kid)) { // refetch once if unknown, so key rotation self-heals
      const oidc = await getJSON(`${issuer}/.well-known/openid-configuration`); // standard across providers
      keys = (await getJSON(oidc.jwks_uri)).keys;
    }
    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk || jwk.kty !== 'RSA') throw new Error('no usable RSA signing key'); // only RS256 keys are supported
    return crypto.createPublicKey({ key: jwk, format: 'jwk' });
  };
  const verify = async (header, resource) => {
    const token = (header || '').replace(/^Bearer /, '');
    if (!token) throw new Error('no token');
    const [h, p, sig] = token.split('.');
    const head = JSON.parse(Buffer.from(h, 'base64url'));
    if (head.alg !== 'RS256') throw new Error('unsupported alg'); // pin the alg; blocks alg-confusion / alg:none
    const pub = await keyFor(head.kid);
    if (!crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(sig, 'base64url'))) throw new Error('bad signature');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    if (payload.exp * 1000 < Date.now()) throw new Error('expired');
    if (payload.iss !== issuer) throw new Error('wrong issuer');
    if (![].concat(payload.aud || []).includes(resource)) throw new Error('wrong audience'); // token must be minted for this server, not another
  };
  return async (req, res) => {
    const base = `http://${req.headers.host}`;
    const prm = `${base}/.well-known/oauth-protected-resource`;
    if (req.url === '/.well-known/oauth-protected-resource') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [issuer] }));
    }
    try { await verify(req.headers.authorization, `${base}/mcp`); }
    catch { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${prm}"` }); return res.end(); }
    handler(req, res);
  };
}
