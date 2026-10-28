import { StringDecoder } from 'node:string_decoder';

export function redactionValues(values) {
  return [...new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
}
export function redact(text, values) {
  for (const value of values) text = text.split(value).join('[REDACTED]');
  return text;
}
export class RedactingStream {
  constructor(values, emit) {
    this.values = values; this.emit = emit; this.pending = ''; this.decoder = new StringDecoder('utf8');
    this.patterns = values.map(value => { const failure = new Uint32Array(value.length); for (let i = 1, j = 0; i < value.length; i++) { while (j && value[i] !== value[j]) j = failure[j - 1]; if (value[i] === value[j]) j++; failure[i] = j; } return { value, failure }; });
  }
  push(bytes) {
    this.pending = redact(this.pending + this.decoder.write(Buffer.from(bytes)), this.values);
    // Only hold a suffix that could actually be the beginning of a secret.
    // Retaining a whole token-length tail would hide interactive prompts indefinitely.
    let keep = 0;
    for (const { value, failure } of this.patterns) {
      let matched = 0;
      const tail = this.pending.slice(-value.length + 1);
      for (let i = 0; i < tail.length; i++) {
        const char = tail[i];
        while (matched && char !== value[matched]) matched = failure[matched - 1];
        if (char === value[matched]) matched++;
        if (matched === value.length) matched = failure[matched - 1];
      }
      keep = Math.max(keep, matched);
    }
    const cut = this.pending.length - keep;
    if (cut) { this.emit(this.pending.slice(0, cut)); this.pending = this.pending.slice(cut); }
  }
  end() { this.emit(redact(this.pending + this.decoder.end(), this.values)); this.pending = ''; this.values = []; this.patterns = []; }
}
