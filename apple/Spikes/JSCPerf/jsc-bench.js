// Interpreter-vs-JIT cross-check for the N3 go/no-go, run with the system
// JavaScriptCore's own `jsc` shell so `--useJIT=false` is actually honoured (the
// JSC_* environment variables are not, and neither is the hardened runtime's
// missing allow-jit entitlement).
//
//   jsc jsc-bench.js -- <recto-core.js>                 # JIT
//   jsc --useJIT=false jsc-bench.js -- <recto-core.js>  # interpreter only
//
// Its job is to confirm that a process without the entitlement performs the same
// as one with the JIT explicitly disabled. Same shape as `JSCPerfCore`: repeated
// rounds, order reshuffled each round, median and p95 — a single sample per size
// measures the engine warming up as much as it measures the document.

const REPETITIONS = 5;
const SIZES = [8, 50, 64, 250];

// Calibrated on this loop, M-series, macOS 26: ~134 ms with the JIT, ~936 ms
// with `--useJIT=false`. An earlier threshold of 3000 ms called both of those
// "JIT", which made the cross-check assert nothing.
const JIT_ADD_LOOP_MS = 400;

let loopStart = Date.now();
let sum = 0;
for (let i = 0; i < 100000000; i++) sum += i;
const addLoop = Date.now() - loopStart;
print(
	`add loop 10^8: ${addLoop} ms  ->  ${addLoop < JIT_ADD_LOOP_MS ? "JIT" : "interpreter"}`,
);

const bundlePath = arguments[0];
const loadStart = Date.now();
load(bundlePath);
print(`load: ${Date.now() - loadStart} ms`);

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

// Deterministic shuffle, so the order differs between rounds but not between
// runs of this script.
let seed = 0x1234abcd;
function nextRandom() {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

const documents = SIZES.map((size) => ({ size, text: prose(size) }));
const samples = new Map(SIZES.map((size) => [size, []]));

for (let round = 0; round < REPETITIONS; round++) {
	const order = documents.slice();
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(nextRandom() * (i + 1));
		[order[i], order[j]] = [order[j], order[i]];
	}
	for (const document of order) {
		const start = Date.now();
		RectoCore.normalize(document.text);
		samples.get(document.size).push(Date.now() - start);
	}
}

function percentile(values, fraction) {
	const sorted = values.slice().sort((a, b) => a - b);
	return sorted[Math.round((sorted.length - 1) * fraction)];
}

for (const { size, text } of documents) {
	const kb = text.length / 1024;
	const values = samples.get(size);
	const median = percentile(values, 0.5);
	print(
		`normalize ${String(size).padStart(4)} kB: median ${String(median).padStart(6)} ms  p95 ${String(percentile(values, 0.95)).padStart(6)} ms  (${(median / kb).toFixed(1)} ms/kB)`,
	);
}
