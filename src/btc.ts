const auth = 'Basic ' + Buffer.from('lb:lb').toString('base64');

export async function rpc<T = any>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:18443${wallet ? `/wallet/${wallet}` : ''}`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
  });
  const j = (await res.json()) as { result: T; error: { message: string } | null };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

export async function ensureMiner(): Promise<string> {
  try {
    await rpc('createwallet', ['miner']);
  } catch {
    await rpc('loadwallet', ['miner']).catch(() => {});
  }
  return rpc<string>('getnewaddress', [], 'miner');
}

export const mine = (n: number, addr: string) => rpc('generatetoaddress', [n, addr]);
