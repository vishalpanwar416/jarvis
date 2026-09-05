// Picks the one argument that identifies a tool call, for compact one-line
// logging. The Ink UI has its own copy in src/ui/ToolLine.jsx.
export function summarize(input = {}) {
  const headline =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.url ?? input.query ?? input.description;
  if (headline !== undefined) return String(headline).replace(/\s+/g, ' ').slice(0, 100);
  const keys = Object.keys(input);
  return keys.length ? `${keys[0]}=${String(input[keys[0]]).slice(0, 60)}` : '';
}
