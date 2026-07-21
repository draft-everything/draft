const tasks = {}, opts = {};

const option = (name, desc, config) => (opts[name] = { desc, ...config });

const argv = () => {
  const args = process.argv.slice(3); // 0:node 1:file 2:task, so options start at 3
  const a = Object.fromEntries(Object.entries(opts).map(([n, c]) => [n, c.default]));
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) continue;
    const key = args[i].slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) { a[key] = next; i++; }
    else a[key] = true; // a flag with no value after it means true
  }
  return a;
};

const draft = (name, desc, fn) => (tasks[name] = { desc, fn });

const series = (...fns) => async () => { for (const f of fns) await run(f); };

const parallel = (...fns) => () => Promise.all(fns.map(run));

const condition = (fn, pred) => () => (pred() ? run(fn) : undefined);

const emit = (report, toText) => console.log(process.env.DRAFT_FORMAT === 'json' ? JSON.stringify(report) : toText(report)); // json mode is what the MCP server reads

const run = async (f) => {
  if (typeof f !== 'string') return f(); // bare functions (from series/parallel) have no name to report
  try {
    const info = await tasks[f].fn(); // a task may return an object of details to show under its ok line
    emit({ status: 'ok', task: f, desc: tasks[f].desc, ...(info && { info }) },
         (r) => `${r.status} ${r.task} — ${r.desc}`
           + (r.info ? `\n   ---\n   ${Object.entries(r.info).map(([k, v]) => `${k}: ${v}`).join('\n   ')}\n   ...` : ''));
  } catch (e) {
    const trace = (e.stack || String(e)).split('\n').slice(0, 3).join('\n');
    emit({ status: 'error', task: f, desc: tasks[f].desc, error: trace },
         (r) => `${r.status} ${r.task} — ${r.desc}\n   ---\n   ${r.error.replace(/\n/g, '\n   ')}\n   ...`);
    throw e; // stop the chain (fail-fast); parents on the way up will report too
  }
};

module.exports = { option, argv, draft, series, parallel, condition };

process.nextTick(() => { // one tick so all tasks are registered before we look one up
  const name = process.argv[2];
  if (!name || !tasks[name]) {
    const t = Object.entries(tasks), o = Object.entries(opts);
    const bad = t.find(([, { desc }]) => typeof desc !== 'string'); // typeof not !desc: a missing desc slides fn into the desc arg
    if (bad) { console.error(`draft('${bad[0]}') needs a description`); process.exit(1); }
    emit({
      tasks: t.map(([n, { desc }]) => ({ name: n, desc })),
      options: o.map(([n, c]) => ({ name: n, desc: c.desc, type: typeof c.default, default: c.default })),
    }, (r) => {
      const w = Math.max(0, ...r.tasks.map((x) => x.name.length), ...r.options.map((x) => x.name.length + 2)); // +2 for the "--" prefix
      const dw = Math.max(0, ...r.options.map((x) => (x.desc || '').length));
      const section = (title, lines) => lines.length ? `\n\n${title}:\n` + lines.join('\n') : ''; // skip empty sections
      return `Usage: node ${require('path').basename(process.argv[1])} <task> [--options]`
        + section('Tasks', r.tasks.map((x) => `  ${x.name.padEnd(w)}  ${x.desc}`))
        + section('Options', r.options.map((x) => `  ${('--' + x.name).padEnd(w)}  ${(x.desc || '').padEnd(dw)}  [default: ${x.default}]`));
    });
    process.exit(name ? 1 : 0);
  }
  run(name).catch(() => process.exit(1));
});

// a welcome tour, only when draft.js is run directly so it never leaks into a task file's tasks
if (require.main === module) {
  draft('welcome', 'start here — how to write a draft task', () => ({
    '1 require': "const { draft, series, parallel, option, argv } = require('draft')",
    '2 a task': "draft('clean', 'empty dist', () => ({ did: 'cleaned' }))",
    '3 an option': "option('prod', 'minify too', { default: false }); argv().prod",
    '4 compose': "draft('tour', 'clean, then both builds', series('clean', parallel('build-a', 'build-b')))",
    'try next': 'node draft.js tour (runs the compose example above)',
  }));
  draft('clean', 'empty dist', () => ({ did: 'cleaned' }));
  draft('build-a', 'one part of the build', () => ({ built: 'a' }));
  draft('build-b', 'another part, runs alongside build-a', () => ({ built: 'b' }));
  draft('tour', 'clean, then both builds', series('clean', parallel('build-a', 'build-b')));
}
