import ts from "https://esm.sh/typescript";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualCompilerHost
} from "https://esm.sh/@typescript/vfs";

const options = {
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ES2020,
  strict: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  moduleResolution: ts.ModuleResolutionKind.NodeJs,

  // source maps + debug
  sourceMap: true,
  inlineSources: true,
  inlineSourceMap: false,
  noEmitOnError: false,
};

// 1. Build lib map
const fsMap = await createDefaultMapFromCDN(
  { target: ts.ScriptTarget.ES2020 },
  "5.4.5",
  false,
  ts
);

// 2. Add files
fsMap.set("/index.ts", `
import data from "./data.json";

type ExpectedData = {
  test: number;
  num: number;
};

const typedData: ExpectedData = data;

console.log(typedData);
`);

fsMap.set("/data.json", JSON.stringify({ value: 123 }));

// 3. System + host
const system = createSystem(fsMap);
const host = createVirtualCompilerHost(system, options, ts);

// 4. Program
const program = ts.createProgram(
  ["/index.ts"],
  options,
  host.compilerHost
);

// 5. Diagnostics (pretty CLI-style)
const diagnostics = ts.getPreEmitDiagnostics(program);

const formatHost = {
  getCanonicalFileName: (f) => f,
  getCurrentDirectory: () => "/",
  getNewLine: () => "\n",
};

console.error(
  ts.formatDiagnosticsWithColorAndContext(diagnostics, formatHost)
);

// 6. Structured diagnostics (machine-friendly)
const structured = diagnostics
  .filter(d => d.file && d.start != null)
  .map(d => {
    const pos = d.file.getLineAndCharacterOfPosition(d.start);
    return {
      file: d.file.fileName,
      line: pos.line + 1,
      column: pos.character + 1,
      code: d.code,
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    };
  });

console.log("Structured diagnostics:", structured);

// 7. Emit
const output = {};

program.emit(undefined, (fileName, content) => {
  output[fileName] = content;
});

console.log("Emitted files:", output);
