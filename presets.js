// Import kapps-api's config/**/presets.toml: a small TOML reader (the subset those files use) and the
// mapping from a sandbox preset to planner workloads. No DOM; units match planner.js (m, MiB).

// ---------- TOML subset ----------
// Supports: comments, [a.b] tables, key = value (bare / quoted / dotted keys), basic and literal strings,
// integers, floats, booleans, arrays (multi-line, trailing commas) and inline tables. Not dates or
// multi-line strings, which presets.toml does not use.
export function parseToml(text) {
	let i = 0;
	const root = {};
	let cur = root;
	const fail = (msg) => {
		const line = text.slice(0, i).split('\n').length;
		throw new Error(`TOML line ${line}: ${msg}`);
	};
	const ws = () => { while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++; };
	const skipTrivia = () => {
		for (;;) {
			ws();
			if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
			if (text[i] === '\n' || text[i] === '\r') i++; else return;
		}
	};
	const bareKey = () => { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i)); if (!m) fail('expected a key'); i += m[0].length; return m[0]; };
	const str = () => {
		const q = text[i++];
		let out = '';
		if (q === "'") { while (i < text.length && text[i] !== "'") out += text[i++]; i++; return out; }
		while (i < text.length && text[i] !== '"') {
			if (text[i] === '\\') {
				const n = text[++i];
				out += ({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' })[n] ?? n;
				i++;
			} else out += text[i++];
		}
		if (text[i] !== '"') fail('unterminated string');
		i++;
		return out;
	};
	const keyPath = () => {
		const path = [];
		for (;;) {
			ws();
			path.push(text[i] === '"' || text[i] === "'" ? str() : bareKey());
			ws();
			if (text[i] === '.') i++; else return path;
		}
	};
	const value = () => {
		ws();
		const c = text[i];
		if (c === '"' || c === "'") return str();
		if (c === '[') {
			i++;
			const arr = [];
			for (;;) {
				skipTrivia();
				if (text[i] === ']') { i++; return arr; }
				arr.push(value());
				skipTrivia();
				if (text[i] === ',') i++;
				else if (text[i] !== ']') fail('expected , or ] in an array');
			}
		}
		if (c === '{') {
			i++;
			const obj = {};
			for (;;) {
				ws();
				if (text[i] === '}') { i++; return obj; }
				const path = keyPath();
				ws();
				if (text[i] !== '=') fail('expected = in an inline table');
				i++;
				setPath(obj, path, value());
				ws();
				if (text[i] === ',') i++;
				else if (text[i] !== '}') fail('expected , or } in an inline table');
			}
		}
		const m = /^[^\s,\]}#]+/.exec(text.slice(i));
		if (!m) fail('expected a value');
		i += m[0].length;
		const t = m[0].replace(/_/g, '');
		if (t === 'true') return true;
		if (t === 'false') return false;
		if (/^[+-]?\d+$/.test(t)) return parseInt(t, 10);
		if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t)) return parseFloat(t);
		return fail(`unsupported value ${m[0]}`);
	};
	const setPath = (obj, path, v) => {
		let o = obj;
		for (const k of path.slice(0, -1)) { o[k] = o[k] && typeof o[k] === 'object' ? o[k] : {}; o = o[k]; }
		o[path[path.length - 1]] = v;
	};
	for (;;) {
		skipTrivia();
		if (i >= text.length) break;
		if (text[i] === '[') {
			i++;
			if (text[i] === '[') fail('arrays of tables are not supported');
			const path = keyPath();
			ws();
			if (text[i] !== ']') fail('expected ]');
			i++;
			cur = root;
			for (const k of path) { cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {}; cur = cur[k]; }
		} else {
			const path = keyPath();
			ws();
			if (text[i] !== '=') fail('expected =');
			i++;
			setPath(cur, path, value());
		}
		ws();
		if (text[i] === '#') while (i < text.length && text[i] !== '\n') i++;
		if (i < text.length && text[i] !== '\n' && text[i] !== '\r') fail('unexpected text after a value');
	}
	return root;
}

/** Layer-style merge: tables merge key by key, everything else (arrays included) is replaced. */
export function deepMerge(base, over) {
	const isTable = (x) => x && typeof x === 'object' && !Array.isArray(x);
	const out = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = isTable(v) && isTable(out[k]) ? deepMerge(out[k], v) : v;
	return out;
}

// ---------- presets -> workloads ----------
const SSH_FORWARD_DEFAULT = { cpu: '50m', memory: '96Mi' }; // sandbox.py _ssh_forward_resources fallback

export function cpuMillis(v) {
	const s = String(v).trim();
	if (/m$/.test(s)) return Math.round(parseFloat(s));
	const n = parseFloat(s);
	if (!Number.isFinite(n)) throw new Error(`bad CPU quantity ${JSON.stringify(v)}`);
	return Math.round(n * 1000);
}

export function memMiB(v) {
	const m = /^([0-9.]+)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(String(v).trim());
	if (!m) throw new Error(`bad memory quantity ${JSON.stringify(v)}`);
	const n = parseFloat(m[1]);
	const f = { Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024, K: 1000 / 1048576, M: 1e6 / 1048576, G: 1e9 / 1048576, T: 1e12 / 1048576 }[m[2] || ''];
	return Math.round(n * (f ?? 1 / 1048576));
}

/** `{cpu, memory, requests?}` as the presets write it: cpu/memory are the limits, requests default to them. */
export function resources(r) {
	const lim = { cpu: cpuMillis(r.cpu ?? 0), mem: memMiB(r.memory ?? 0) };
	const req = r.requests || {};
	return {
		cpuReq: req.cpu != null ? cpuMillis(req.cpu) : lim.cpu, memReq: req.memory != null ? memMiB(req.memory) : lim.mem,
		cpuLim: lim.cpu, memLim: lim.mem,
	};
}

const sumRes = (list) => list.reduce((a, r) => ({ cpuReq: a.cpuReq + r.cpuReq, memReq: a.memReq + r.memReq, cpuLim: a.cpuLim + r.cpuLim, memLim: a.memLim + r.memLim }),
	{ cpuReq: 0, memReq: 0, cpuLim: 0, memLim: 0 });

/**
 * Pods one sandbox of `presetName` runs, per the merged presets config:
 *  - the sandbox pod: its container + the Caddy sidecar when `caddy` is set,
 *  - the agent pod, when the preset has an `agent`: the agent + the ssh relay.
 * Init containers (seed, database wait) are left out: they run before the others and are smaller.
 * Returns { presetName, pods: [{ name, ...resources }], nodeSelector, tolerations } or throws.
 */
export function sandboxPods(cfg, presetName) {
	const presets = cfg.presets || {};
	const name = presetName || cfg.default_preset || Object.keys(presets)[0];
	const p = presets[name];
	if (!p) throw new Error(`no preset named ${JSON.stringify(name)} (have: ${Object.keys(presets).join(', ') || 'none'})`);
	if (!p.resources) throw new Error(`preset ${name} has no resources`);
	const parts = [resources(p.resources)];
	if (p.caddy && cfg.caddy_resources) parts.push(resources(cfg.caddy_resources));
	const pods = [{ name: 'sandbox', ...sumRes(parts) }];
	if (p.agent?.resources) {
		pods.push({ name: 'agent', ...sumRes([resources(p.agent.resources), resources(cfg.ssh_forward_resources || SSH_FORWARD_DEFAULT)]) });
	}
	return { presetName: name, pods, nodeSelector: cfg.node_selector || {}, tolerations: cfg.tolerations || [] };
}
