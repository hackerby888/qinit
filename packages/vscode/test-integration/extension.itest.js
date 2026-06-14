// Integration tests — driven by @vscode/test-electron in a real (headless) VS Code, so they exercise
// the actual providers (activation, diagnostics, hover) end-to-end, not just the pure logic. Plain
// CommonJS (the extension host is Node); `vscode` is provided by the host.
const assert = require("node:assert");
const vscode = require("vscode");

const EXT_ID = "qubic.qpi-vscode";
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

  test("activates and registers the palette commands", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension is present");
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const c of ["qpi.regenerateConfig", "qpi.build", "qpi.deploy", "qpi.up"]) {
      assert.ok(cmds.includes(c), `command ${c} should be registered`);
    }
  });

  test("Tier-A diagnostics fire on a violating contract", async () => {
    const doc = await open("Bad.h");
    await sleep(2500); // let onDidOpen -> refresh publish
    const codes = vscode.languages.getDiagnostics(doc.uri).map((d) => String(d.code));
    assert.ok(codes.includes("qpi/no-division"), `expected qpi/no-division; got [${codes.join(", ")}]`);
    assert.ok(codes.includes("qpi/no-brackets"), `expected qpi/no-brackets; got [${codes.join(", ")}]`);
  });

  test("a clean contract produces no Tier-A diagnostics", async () => {
    const doc = await open("Counter.h");
    await sleep(2500);
    const qpi = vscode.languages.getDiagnostics(doc.uri).filter((d) => String(d.source) === "qpi");
    assert.strictEqual(qpi.length, 0, `clean contract should have no qpi diagnostics; got ${qpi.map((d) => d.code).join(", ")}`);
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

  test("CodeLens exposes contract + per-fn call actions", async () => {
    const doc = await open("Counter.h");
    const lenses = await vscode.commands.executeCommand("vscode.executeCodeLensProvider", doc.uri);
    const titles = (lenses || []).map((l) => (l.command && l.command.title) || "").join(" | ");
    assert.ok(/build/.test(titles), `expected a build lens; got: ${titles}`);
    assert.ok(/call get/.test(titles), `expected a 'call get' lens; got: ${titles}`);
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
});
