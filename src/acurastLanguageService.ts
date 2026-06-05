import * as vscode from 'vscode';
import * as fs from 'fs';
import {
  getLanguageService,
  TextDocument as LSTextDocument,
  InsertTextFormat,
  type JSONSchema,
} from 'vscode-json-languageservice';

const LANGUAGE_ID = 'acurast-config';

function toLSDoc(doc: vscode.TextDocument): LSTextDocument {
  return LSTextDocument.create(doc.uri.toString(), 'json', doc.version, doc.getText());
}

function toVsRange(r: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
}

export function registerAcurastLanguageService(
  extensionContext: vscode.ExtensionContext
): vscode.Disposable[] {
  const schemaPath = vscode.Uri.joinPath(extensionContext.extensionUri, 'schemas', 'acurast.schema.json').fsPath;
  let schema: JSONSchema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8')) as JSONSchema;
  } catch (err) {
    // A missing/corrupt schema must not abort extension activation — degrade by
    // skipping diagnostics/completions/hover entirely.
    console.error('Acurast language service: failed to load schema, disabling:', err);
    return [];
  }
  const schemaUri = 'acurast://schemas/acurast.schema.json';

  const ls = getLanguageService({
    schemaRequestService: (uri) => {
      if (uri === schemaUri) return Promise.resolve(JSON.stringify(schema));
      return Promise.reject(new Error(`Unknown schema: ${uri}`));
    },
  });

  ls.configure({
    validate: true,
    allowComments: false,
    schemas: [{ uri: schemaUri, fileMatch: ['**/acurast.json'], schema }],
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────
  const diagCollection = vscode.languages.createDiagnosticCollection(LANGUAGE_ID);

  async function validate(doc: vscode.TextDocument) {
    if (doc.languageId !== LANGUAGE_ID) return;
    const lsDoc = toLSDoc(doc);
    const jsonDoc = ls.parseJSONDocument(lsDoc);
    const diags = await ls.doValidation(lsDoc, jsonDoc, { schemaValidation: 'error' });
    diagCollection.set(
      doc.uri,
      diags.map(d => new vscode.Diagnostic(toVsRange(d.range),
        typeof d.message === 'string' ? d.message : d.message.value,
        ((d.severity ?? 2) - 1) as vscode.DiagnosticSeverity))
    );
  }

  // ── Completions ───────────────────────────────────────────────────────────
  const completionProvider = vscode.languages.registerCompletionItemProvider(
    { language: LANGUAGE_ID },
    {
      async provideCompletionItems(doc, position) {
        const lsDoc = toLSDoc(doc);
        const jsonDoc = ls.parseJSONDocument(lsDoc);
        const list = await ls.doComplete(lsDoc, { line: position.line, character: position.character }, jsonDoc);
        if (!list) return [];
        return list.items.map(item => {
          const labelStr = typeof item.label === 'string' ? item.label : (item.label as { label: string }).label;
          const ci = new vscode.CompletionItem(
            labelStr,
            item.kind != null ? (item.kind - 1) as vscode.CompletionItemKind : vscode.CompletionItemKind.Text
          );
          ci.detail = item.detail;
          if (item.documentation) {
            ci.documentation = typeof item.documentation === 'string'
              ? item.documentation
              : new vscode.MarkdownString(item.documentation.value);
          }
          const te = item.textEdit as { range: any; newText: string } | undefined;
          if (te) {
            ci.range = toVsRange(te.range);
            ci.insertText = item.insertTextFormat === InsertTextFormat.Snippet
              ? new vscode.SnippetString(te.newText)
              : te.newText;
          } else if (item.insertText) {
            ci.insertText = item.insertTextFormat === InsertTextFormat.Snippet
              ? new vscode.SnippetString(item.insertText)
              : item.insertText;
          }
          ci.filterText = item.filterText;
          ci.sortText = item.sortText;
          return ci;
        });
      },
    },
    '"', ':', ' ', '\n', '{'
  );

  // ── Hover ─────────────────────────────────────────────────────────────────
  const hoverProvider = vscode.languages.registerHoverProvider(
    { language: LANGUAGE_ID },
    {
      async provideHover(doc, position) {
        const lsDoc = toLSDoc(doc);
        const jsonDoc = ls.parseJSONDocument(lsDoc);
        const hover = await ls.doHover(lsDoc, { line: position.line, character: position.character }, jsonDoc);
        if (!hover?.contents) return null;
        const c = hover.contents;
        const md = typeof c === 'string'
          ? new vscode.MarkdownString(c)
          : Array.isArray(c)
            ? new vscode.MarkdownString(c.map(x => typeof x === 'string' ? x : x.value).join('\n\n'))
            : new vscode.MarkdownString((c as any).value ?? String(c));
        md.isTrusted = false;
        return new vscode.Hover(md, hover.range ? toVsRange(hover.range) : undefined);
      },
    }
  );

  const openSub = vscode.workspace.onDidOpenTextDocument(validate);
  const changeSub = vscode.workspace.onDidChangeTextDocument(e => validate(e.document));
  const closeSub = vscode.workspace.onDidCloseTextDocument(d => diagCollection.delete(d.uri));

  vscode.workspace.textDocuments.forEach(validate);

  return [diagCollection, completionProvider, hoverProvider, openSub, changeSub, closeSub];
}
