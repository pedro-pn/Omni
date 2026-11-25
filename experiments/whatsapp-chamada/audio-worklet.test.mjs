import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./web/audio-worklet.js', import.meta.url), 'utf8');

function processor() {
  let Processor;
  const messages = [];
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class { constructor() { this.port = {postMessage: data => messages.push(data)}; } },
    registerProcessor: (_name, implementation) => { Processor = implementation; },
  });
  const instance = new Processor();
  return {instance, messages};
}

function audio(instance, samples = 960, value = 8192) {
  const buffer = new ArrayBuffer(samples * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples; i++) view.setInt16(i*2, value, true);
  instance.port.onmessage({data:{type:'audio', buffer}});
}

function render(instance, samples = 128, inputValue = 0) {
  const output = new Float32Array(samples);
  instance.process([[new Float32Array(samples).fill(inputValue)]], [[output]]);
  return output;
}

test('aguarda reserva de áudio e mantém sinal contínuo entre pacotes', () => {
  const {instance} = processor();
  audio(instance);
  assert.ok(render(instance).every(value => value === 0));
  audio(instance);
  const first = render(instance);
  assert.ok(first[0] > 0 && first[0] < .01, 'entrada deve ser gradual');
  assert.equal(first.at(-1), .25);
  for (let i = 0; i < 6; i++) assert.ok(render(instance).every(value => value === .25));
  // Variação de chegada: o novo pacote entra depois de consumir quase um quadro.
  audio(instance);
  for (let i = 0; i < 7; i++) assert.ok(render(instance).every(value => value === .25));
});

test('falta de pacotes termina suavemente e exige nova reserva antes de retomar', () => {
  const {instance} = processor();
  audio(instance, 1920);
  let previous = 0;
  for (let block = 0; block < 17; block++) {
    for (const value of render(instance)) {
      assert.ok(Math.abs(value - previous) < .004, 'transição não pode dar um salto');
      previous = value;
    }
  }
  assert.equal(previous, 0);
  audio(instance);
  assert.ok(render(instance).every(value => value === 0));
  audio(instance);
  assert.ok(render(instance).some(value => value > 0));
});

test('reset remove áudio da chamada anterior e captura mantém PCM e silêncio', () => {
  const {instance, messages} = processor();
  audio(instance, 1920);
  instance.port.onmessage({data:{type:'reset'}});
  assert.ok(render(instance).every(value => value === 0));
  for (let i = 0; i < 8; i++) render(instance, 128, .25);
  const view = new DataView(messages[0]);
  assert.equal(view.byteLength, 1920);
  assert.equal(view.getInt16(256, true), 8192);
  instance.port.onmessage({data:{type:'reset'}});
  instance.port.onmessage({data:{type:'mute', value:true}});
  messages.length = 0;
  for (let i = 0; i < 8; i++) render(instance, 128, .25);
  const muted = new DataView(messages[0]);
  for (let i = 0; i < muted.byteLength; i+=2) assert.equal(muted.getInt16(i, true), 0);
});
