const assert = require("node:assert");
const fs = require("node:fs");
const vscode = require("vscode");

const EXT_ID = "qinit.qpi-vscode";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wsUri(name) {
  return vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
}
async function open(name) {
  const doc = await vscode.workspace.openTextDocument(wsUri(name));
  await vscode.window.showTextDocument(doc);
  return doc;
}

suite("Qubic QPI extension", function () {
  this.timeout(120000);

  test("activates with only the clangd maintenance command", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension is present");
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes("qpi.regenerateConfig"), "qpi.regenerateConfig should be registered");
    for (const c of ["qpi.build", "qpi.deploy", "qpi.call", "qpi.gen", "qpi.test", "qpi.up"]) {
      assert.ok(!cmds.includes(c), `command ${c} should NOT be registered (removed for simplicity)`);
    }
  });

  test("diagnostics fire on a violating contract", async () => {
    const doc = await open("Bad.h");
    await sleep(2500); // let onDidOpen -> refresh publish
    const codes = vscode.languages.getDiagnostics(doc.uri).map((d) => String(d.code));
    assert.ok(codes.includes("qpi/no-division"), `expected qpi/no-division; got [${codes.join(", ")}]`);
    assert.ok(codes.includes("qpi/no-brackets"), `expected qpi/no-brackets; got [${codes.join(", ")}]`);
  });

  test("a clean contract produces no QPI diagnostics", async () => {
    const doc = await open("Counter.h");
    await sleep(2500);
    const diagnostics = vscode.languages.getDiagnostics(doc.uri);
    const qpi = diagnostics.filter((d) => String(d.source) === "qpi");
    const clang = diagnostics.filter((d) => String(d.source) === "clang");
    assert.strictEqual(qpi.length, 0, `clean contract should have no qpi diagnostics; got ${qpi.map((d) => d.code).join(", ")}`);
    assert.strictEqual(clang.length, 0, `clean contract should have no clang diagnostics; got ${clang.map((d) => d.code).join(", ")}`);
  });

  test("plain C++ headers are ignored", async () => {
    const doc = await open("Plain.h");
    await sleep(1000);
    const qpi = vscode.languages.getDiagnostics(doc.uri).filter((d) => d.source === "qpi");
    assert.strictEqual(qpi.length, 0, "plain C++ should not receive QPI diagnostics");
  });

  test("IDL hover shows the index + codec for a registered function", async () => {
    const doc = await open("Counter.h");
    const marker = "PUBLIC_FUNCTION(";
    const pos = doc.positionAt(doc.getText().indexOf(marker) + marker.length); // on `get`
    const hovers = await vscode.commands.executeCommand("vscode.executeHoverProvider", doc.uri, pos);
    const text = (hovers || [])
      .flatMap((h) => h.contents.map((c) => (typeof c === "string" ? c : c.value)))
      .join("\n");
    assert.ok(/QPI function/.test(text), `hover should name the QPI function; got: ${text}`);
    assert.ok(/index/.test(text), `hover should show the index; got: ${text}`);
  });

  test("no QPI CodeLens buttons (removed for simplicity)", async () => {
    const doc = await open("Counter.h");
    const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", doc.uri);
    const titles = (lenses || []).map((l) => (l.command && l.command.title) || "").join(" | ");
    assert.ok(!/build|deploy|call|gen client/i.test(titles), `expected no QPI action lenses; got: ${titles}`);
  });

  test("standalone contract and test files receive a clangd database", async () => {
    await open("Counter.h");
    await open("Counter.test.cpp");
    await sleep(1500);

    const config = wsUri(".clangd").fsPath;
    assert.ok(fs.existsSync(config), ".clangd should be generated without qinit.json");
    const text = fs.readFileSync(config, "utf8");
    assert.match(text, /CompilationDatabase:/);
  });

  test("quick-fix offers Array<T, N> for a bracket violation", async () => {
    const doc = await open("Bad.h");
    await sleep(1500);
    const brackets = vscode.languages.getDiagnostics(doc.uri).filter((d) => String(d.code) === "qpi/no-brackets");
    assert.ok(brackets.length, "should have a bracket diagnostic");
    const actions = await vscode.commands.executeCommand("vscode.executeCodeActionProvider", doc.uri, brackets[0].range);
    const titles = (actions || []).map((a) => a.title);
    assert.ok(titles.some((t) => /Array<T, N>/.test(t)), `expected the Array<T, N> quick-fix; got: ${titles.join(", ")}`);
  });

  test("locals diagnostics fire; the qpi.h dev-include is exempt", async () => {
    const doc = await open("Locals.h");
    await sleep(2500);
    const diags = vscode.languages.getDiagnostics(doc.uri);
    const qpiCodes = diags.filter((d) => String(d.source) === "qpi").map((d) => String(d.code));
    assert.ok(qpiCodes.includes("qpi/stack-local"), `expected qpi/stack-local; got [${qpiCodes.join(", ")}]`);
    assert.ok(qpiCodes.includes("qpi/needs-with-locals"), `expected qpi/needs-with-locals; got [${qpiCodes.join(", ")}]`);
    const onInclude = diags.filter((d) => String(d.source) === "qpi" && d.range.start.line === 2);
    assert.strictEqual(onInclude.length, 0, `qpi.h include should be exempt; got [${onInclude.map((d) => d.code).join(", ")}]`);
  });
});
