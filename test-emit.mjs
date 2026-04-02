import { compilePipeline } from "./script-gen/pipeline-compiler.js";
import { emitPython } from "./script-gen/python-emitter.js";
import { emitNode } from "./script-gen/node-emitter.js";

const recipe = {
  name: "Test Recursion Pipeline",
  steps: [
    { type: "NAVIGATE", config: { url: "https://example.com" } },
    { type: "LOOP", config: { type: "elements", selector: ".item", max: 5 }, children: [
        { type: "CLICK", config: { selector: ".item >> button" } },
        { type: "WAIT", config: { ms: 1000 } }
    ]},
    { type: "IF_ELSE", config: { condition: "exists", selector: ".alert" }, ifBranch: [
        { type: "EXTRACT", config: { fields: [{name: "msg", selector: ".alert"}] } }
    ], elseBranch: [
        { type: "SCROLL", config: { value: 500 } }
    ]}
  ]
};

const compileResult = compilePipeline(recipe);
console.log("AST recursively mapped children:", !!compileResult.ast.steps[1].children);
console.log("AST recursively mapped ifBranch:", !!compileResult.ast.steps[2].ifBranch);

const pyCode = emitPython(compileResult.ast);
console.log("\n=== PYTHON ===");
console.log(pyCode.includes("for i, el in enumerate(elements[:5]):") ? "PASS: Loop Python" : "FAIL: Loop Python");
console.log(pyCode.includes('if await page.locator(".alert").count() > 0:') ? "PASS: IfElse Python" : "FAIL: IfElse Python");

const nodeCode = emitNode(compileResult.ast);
console.log("\n=== NODE ===");
console.log(nodeCode.includes("for (let i = 0; i < Math.min(elements.length, 5); i++) {") ? "PASS: Loop Node" : "FAIL: Loop Node");
console.log(nodeCode.includes("if (await page.locator('.alert').count() > 0) {") ? "PASS: IfElse Node" : "FAIL: IfElse Node");
