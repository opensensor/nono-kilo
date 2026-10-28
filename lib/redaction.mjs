import { StringDecoder } from 'node:string_decoder';

export function redactionValues(values) {
  return [...new Set(values.filter(Boolean).flatMap(value => [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
}
export function redact(text, values) {
  for (const value of values) text = text.split(value).join('[REDACTED]');
  return text;
}
export class RedactingStream {
  constructor(values, emit) { this.values = values; this.emit = emit; this.pending = ''; this.decoder = new StringDecoder('utf8'); this.keep = Math.max(1, ...values.map(v => v.length)) - 1; }
  push(bytes) {
    this.pending = redact(this.pending + this.decoder.write(Buffer.from(bytes)), this.values);
    const cut = Math.max(0, this.pending.length - this.keep);
    if (cut) { this.emit(this.pending.slice(0, cut)); this.pending = this.pending.slice(cut); }
  }
  end() { this.emit(redact(this.pending + this.decoder.end(), this.values)); this.pending = ''; this.values = []; }
}
