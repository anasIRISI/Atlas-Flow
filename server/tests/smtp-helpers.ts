import { createServer, type AddressInfo, type Socket } from 'node:net';
import PostalMime, { type Email } from 'postal-mime';
import { SMTPServer } from 'smtp-server';

export interface ReceivedMail {
  envelope: { from: string; to: string[] };
  /** Parsed MIME message (subject, html, text, attachments…). */
  mail: Email;
  raw: string;
  /** User that signed in, if any. */
  user?: string;
}

export interface FakeSmtp {
  port: number;
  messages: ReceivedMail[];
  close(): Promise<void>;
}

/** Local SMTP server for tests: no TLS, optional login, keeps every received message. */
export async function startFakeSmtp(login?: { user: string; pass: string }): Promise<FakeSmtp> {
  const messages: ReceivedMail[] = [];
  const server = new SMTPServer({
    secure: false,
    authOptional: !login,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, _session, callback) {
      if (login && auth.username === login.user && auth.password === login.pass) return callback(null, { user: auth.username });
      const err = Object.assign(new Error('Invalid username or password'), { responseCode: 535 });
      return callback(err);
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks);
        void PostalMime.parse(raw).then((mail) => {
          messages.push({
            envelope: {
              from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
              to: session.envelope.rcptTo.map((r) => r.address),
            },
            mail,
            raw: raw.toString('utf8'),
            user: session.user as string | undefined,
          });
          callback();
        }, callback);
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.server.address() as AddressInfo;
  return { port, messages, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Accepts TCP connections and never answers (to test SMTP timeouts). */
export async function startSilentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** SMTP credential values pointing at a fake server. */
export const smtpData = (port: number, login?: { user: string; pass: string }) => ({
  host: '127.0.0.1',
  port,
  secure: false,
  ...(login ? { user: login.user, password: login.pass } : {}),
});
