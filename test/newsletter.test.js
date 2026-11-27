import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { proto } from 'baileys';
import { sendNewsletterPoll, waitForAck } from '../src/newsletter.js';

function fakeSock(ackFor) {
  const ws = new EventEmitter();
  const sent = [];
  return {
    ws,
    sent,
    user: { id: '5491100000000:1@s.whatsapp.net' },
    sendNode: async (node) => {
      sent.push(node);
      setImmediate(() => ws.emit('CB:ack,class:message', { attrs: { id: node.attrs.id, ...ackFor(node) } }));
    },
  };
}

test('una encuesta para canal lleva polltype y espera la confirmación', async () => {
  const sock = fakeSock(() => ({}));
  await sendNewsletterPoll(sock, '1@newsletter', { name: '¿Cuál?', values: ['A', 'B'], multi: false, correctIndex: null });
  const [node] = sock.sent;
  assert.equal(node.attrs.type, 'poll');
  assert.deepEqual(node.content[1], { tag: 'meta', attrs: { polltype: 'creation' } });
  const msg = proto.Message.decode(node.content[0].content);
  assert.equal(msg.pollCreationMessageV3.name, '¿Cuál?');
});

test('el cuestionario marca la respuesta correcta', async () => {
  const sock = fakeSock(() => ({}));
  await sendNewsletterPoll(sock, '1@newsletter', { name: '2+2', values: ['3', '4'], correctIndex: 1 });
  const msg = proto.Message.decode(sock.sent[0].content[0].content);
  assert.equal(msg.pollCreationMessageV5.pollType, proto.Message.PollType.QUIZ);
  assert.equal(msg.pollCreationMessageV5.correctAnswer.optionName, '4');
});

test('si WhatsApp rechaza el mensaje, el envío falla', async () => {
  const sock = fakeSock(() => ({ error: '479' }));
  await assert.rejects(
    sendNewsletterPoll(sock, '1@newsletter', { name: 'x', values: ['A', 'B'] }),
    /código 479/
  );
});

test('sin confirmación a tiempo, falla', async () => {
  const sock = { ws: new EventEmitter() };
  await assert.rejects(waitForAck(sock, 'abc', 20), /no confirmó/);
});

test('si falla el envío, se deja de esperar el ack (no tumba el proceso después)', async () => {
  const sock = fakeSock(() => ({}));
  sock.sendNode = async () => { throw new Error('socket cerrado'); };
  await assert.rejects(sendNewsletterPoll(sock, '1@newsletter', { name: 'x', values: ['A', 'B'] }), /socket cerrado/);
  assert.equal(sock.ws.listenerCount('CB:ack,class:message'), 0);
});
