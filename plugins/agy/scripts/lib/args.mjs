// args.mjs — tiny argv parser without external deps.
//
// Design contract:
//   - Boolean flags: `--background`, `--wait`, `--fresh`, `--resume`.
//   - Value flags: `--model X`, `--model=X`, `--base ref`, `--base=ref`.
//   - Unknown flags are passed through to `extra` so callers can
//     forward agy-native flags (e.g. `--sandbox`, `--print-timeout`).
//   - Positional args become `positional`.
//   - `--` terminates flag parsing; everything after lands in
//     `positional` verbatim (so a prompt with a leading `-` is safe).
//   - `--flag=` with an empty value is reported via `errors` rather
//     than silently consuming the next token (matches the wrapper's
//     0.4.1 convention).

export function parseArgs(argv, schema) {
  const out = {
    flags: {},
    values: {},
    positional: [],
    extra: [],
    errors: [],
  };
  for (const flag of schema.boolean ?? []) {
    out.flags[flag] = false;
  }
  for (const flag of schema.value ?? []) {
    out.values[flag] = null;
  }

  let i = 0;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === "--") {
      out.positional.push(...argv.slice(i + 1));
      break;
    }
    // --flag=value  or  --flag
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const valueInline = eq === -1 ? null : tok.slice(eq + 1);
      if ((schema.boolean ?? []).includes(name)) {
        if (valueInline !== null) {
          out.errors.push(`--${name} does not take a value`);
        } else {
          out.flags[name] = true;
        }
        i += 1;
        continue;
      }
      if ((schema.value ?? []).includes(name)) {
        if (valueInline !== null) {
          if (valueInline === "") {
            out.errors.push(`--${name}= requires a non-empty value`);
          } else {
            out.values[name] = valueInline;
          }
          i += 1;
          continue;
        }
        // Space-separated value.
        if (i + 1 >= argv.length) {
          out.errors.push(`--${name} requires a value`);
          i += 1;
          continue;
        }
        out.values[name] = argv[i + 1];
        i += 2;
        continue;
      }
      // Unknown long flag — forward to `extra`. Take next token too if
      // it doesn't look like another flag, so `--print-timeout 10m`
      // forwards both halves.
      out.extra.push(tok);
      if (eq === -1 && i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        out.extra.push(argv[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // Positional
    out.positional.push(tok);
    i += 1;
  }
  return out;
}

// Convenience: join positional args back into a single prompt string.
// Most slash commands pass the user's free-form text as multiple
// positional tokens.
export function joinPositional(parsed) {
  return parsed.positional.join(" ").trim();
}

// Split a single string argument as if the shell had tokenized it.
// Handles `'...'`, `"..."`, and bare tokens. Used when the slash
// command hands us $ARGUMENTS as one big string instead of pre-split.
export function splitArgString(s) {
  const out = [];
  let buf = "";
  let mode = "none"; // 'none' | 'single' | 'double'
  let escaped = false;
  for (const ch of s ?? "") {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (mode === "single") {
      if (ch === "'") mode = "none";
      else buf += ch;
      continue;
    }
    if (mode === "double") {
      if (ch === '"') mode = "none";
      else if (ch === "\\") escaped = true;
      else buf += ch;
      continue;
    }
    // mode === none
    if (ch === "'") { mode = "single"; continue; }
    if (ch === '"') { mode = "double"; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (buf.length > 0) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}
