// Interpreter-vs-JIT proxy for the N3 go/no-go, run with the system
// JavaScriptCore's own `jsc` shell so `--useJIT=false` is actually honoured
// (the JSC_* environment variables are not, and neither is the hardened
// runtime's missing allow-jit entitlement).
//
//   jsc jsc-bench.js -- <recto-core.js>                 # JIT
//   jsc --useJIT=false jsc-bench.js -- <recto-core.js>  # LLInt only

function now() {
	return Date.now();
}

let loopStart = now();
let sum = 0;
for (let i = 0; i < 100000000; i++) sum += i;
const addLoop = now() - loopStart;
print(`add loop 10^8: ${addLoop} ms  ->  ${addLoop < 3000 ? "JIT" : "interpreter"}`);

const bundlePath = arguments[0];
const loadStart = now();
load(bundlePath);
print(`load: ${now() - loadStart} ms`);

const paragraph =
	"The quick brown fox jumps over the lazy dog, and then does it again " +
	"because that is what foxes in benchmark documents are for. Some of " +
	"this is **bold**, some is _italic_, and one clause has a " +
	"[link](https://example.com) in it.\n\n";

function prose(kilobytes) {
	let out = "";
	while (out.length < kilobytes * 1024) out += paragraph;
	return out;
}

for (const size of [8, 50, 64, 250]) {
	const document = prose(size);
	const kb = document.length / 1024;
	const start = now();
	RectoCore.normalize(document);
	const elapsed = now() - start;
	print(
		`normalize ${String(size).padStart(4)} kB: ${String(elapsed).padStart(7)} ms  (${(elapsed / kb).toFixed(1)} ms/kB)`,
	);
}
