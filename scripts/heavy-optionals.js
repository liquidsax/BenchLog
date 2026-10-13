/**
 * Optional stacks BenchLog does not install.
 * The marker matches `vendor/omitted-optional/package.json`.
 */
export const OMIT_MARKER = "BenchLog omits this optional dependency";

/** Package names replaced by the empty stub, or deleted if a parent install fetched the real tarball. */
export const HEAVY_PACKAGES = [
	"@huggingface/transformers",
	"@huggingface/tokenizers",
	"sherpa-onnx",
	"sherpa-onnx-node",
	"sherpa-onnx-linux-x64",
	"sherpa-onnx-linux-arm64",
	"sherpa-onnx-darwin-x64",
	"sherpa-onnx-darwin-arm64",
	"sherpa-onnx-win-x64",
	"sherpa-onnx-win-ia32",
	"onnxruntime-node",
	"onnxruntime-web",
	"onnxruntime-common",
	"fastembed",
	"lucide-react",
	"react",
	"react-dom",
];
