import {
	connect
} from 'cloudflare:sockets';

// 重用编码器/解码器以避免每次请求都创建新的实例
const te = new TextEncoder();
const td = new TextDecoder();

// 缓存解码后的myID以避免重复计算
const MY_ID_BYTES = (() => {
	const myID = '78f2c50b-9062-4f73-823d-f2c15d3e332c';
	const expectedmyID = myID.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(expectedmyID.substr(i * 2, 2), 16);
	}
	return bytes;
})();

export default {
	async fetch(req, env) {
		if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
			const [client, ws] = Object.values(new WebSocketPair());
			ws.accept();

			const u = new URL(req.url);
			// 修复处理URL编码的查询参数
			if (u.pathname.includes('%3F')) {
				const decoded = decodeURIComponent(u.pathname);
				const queryIndex = decoded.indexOf('?');
				if (queryIndex !== -1) {
					u.search = decoded.substring(queryIndex);
					u.pathname = decoded.substring(0, queryIndex);
				}
			}

			let mode = 'd'; // default mode
			let skJson;
			let sParam = u.searchParams.get('s');
			let pParam;
			if (sParam) {
				mode = 's';
				skJson = getSKJson(sParam);
			} else {
				const gParam = u.searchParams.get('g');
				if (gParam) {
					sParam = gParam;
					skJson = getSKJson(gParam);
					mode = 'g';
				} else {
					pParam = u.searchParams.get('p');
					if (pParam) {
						mode = 'p';
					}
				}
			}

			let remote = null, udpWriter = null, isDNS = false;

			new ReadableStream({
				start(ctrl) {
					ws.addEventListener('message', e => ctrl.enqueue(e.data));
					ws.addEventListener('close', () => {
						remote?.close();
						ctrl.close();
					});
					ws.addEventListener('error', () => {
						remote?.close();
						ctrl.error();
					});

					const early = req.headers.get('sec-websocket-protocol');
					if (early) {
						try {
							// 优化Base64解码，使用预定义的编码器
							const binStr = atob(early.replace(/-/g, '+').replace(/_/g, '/'));
							const buffer = new ArrayBuffer(binStr.length);
							const arr = new Uint8Array(buffer);
							for (let i = 0; i < binStr.length; i++) {
								arr[i] = binStr.charCodeAt(i);
							}
							ctrl.enqueue(buffer);
						} catch { }
					}
				}
			}).pipeTo(new WritableStream({
				async write(data) {
					if (isDNS) return udpWriter?.write(data);
					if (remote) {
						const w = remote.writable.getWriter();
						await w.write(data);
						w.releaseLock();
						return;
					}

					// 优化长度检查
					if (data.byteLength < 24) return;

					// 使用从环境变量获取的MY_ID_BYTES进行快速验证
					const dataView = new DataView(data);
					for (let i = 0; i < 16; i++) {
						if (dataView.getUint8(1 + i) !== MY_ID_BYTES[i]) return;
					}

					const optLen = dataView.getUint8(17);
					const cmd = dataView.getUint8(18 + optLen);
					if (cmd !== 1 && cmd !== 2) return;

					let pos = 19 + optLen;
					const port = dataView.getUint16(pos);
					const type = dataView.getUint8(pos + 2);
					pos += 3;

					let addr = '';
					if (type === 1) {
						// 优化IPv4地址构造，避免字符串拼接
						const ipParts = [
							dataView.getUint8(pos),
							dataView.getUint8(pos + 1),
							dataView.getUint8(pos + 2),
							dataView.getUint8(pos + 3)
						];
						addr = ipParts.join('.');
						pos += 4;
					} else if (type === 2) {
						// 使用预定义的TextDecoder
						const len = dataView.getUint8(pos++);
						addr = td.decode(data.slice(pos, pos + len));
						pos += len;
					} else if (type === 3) {
						// IPv6
						const ipv6 = [];
						for (let i = 0; i < 8; i++, pos += 2) {
							ipv6.push(dataView.getUint16(pos).toString(16));
						}
						addr = ipv6.join(':');
					} else return;

					const header = new Uint8Array([data[0], 0]);
					const payload = data.slice(pos);

					// UDP DNS
					if (cmd === 2) {
						if (port !== 53) return;
						isDNS = true;
						let sent = false;
						const {
							readable,
							writable
						} = new TransformStream({
							transform(chunk, ctrl) {
								for (let i = 0; i < chunk.byteLength;) {
									const len = new DataView(chunk.slice(i, i + 2))
										.getUint16(0);
									ctrl.enqueue(chunk.slice(i + 2, i + 2 + len));
									i += 2 + len;
								}
							}
						});

						readable.pipeTo(new WritableStream({
							async write(query) {
								try {
									const resp = await fetch(
										'https://1.1.1.1/dns-query', {
										method: 'POST',
										headers: {
											'content-type': 'application/dns-message'
										},
										body: query
									});
									if (ws.readyState === 1) {
										const result = new Uint8Array(await resp
											.arrayBuffer());
										ws.send(new Uint8Array([...(sent ? [] :
											header), result
												.length >> 8, result
													.length & 0xff, ...result
										]));
										sent = true;
									}
								} catch { }
							}
						}));
						udpWriter = writable.getWriter();
						return udpWriter.write(payload);
					}

					// TCP连接 - 使用优化的连接建立逻辑
					let conn = null;
					const connectionMethods = getOrder(mode);

					// 使用Promise.any并行尝试不同的连接方法
					const connectionPromises = [];
					for (const method of connectionMethods) {
						if (method === 'd') {
							connectionPromises.push(connectDirect(addr, port));
						} else if (method === 's' && skJson) {
							connectionPromises.push(sConnect(addr, port, skJson));
						} else if (method === 'p' && pParam) {
							const [ph, pp = port] = pParam.split(':');
							connectionPromises.push(connectDirect(ph, +pp || port));
						}
					}

					try {
						if (connectionPromises.length > 0) {
							conn = await Promise.any(connectionPromises);
						}
					} catch {
						// 所有连接尝试都失败了
						return;
					}

					if (!conn) return;

					remote = conn;
					const w = conn.writable.getWriter();
					await w.write(payload);
					w.releaseLock();

					let sent = false;
					conn.readable.pipeTo(new WritableStream({
						write(chunk) {
							if (ws.readyState === 1) {
								ws.send(sent ? chunk : new Uint8Array([...header, ...
									new Uint8Array(chunk)
								]));
								sent = true;
							}
						},
						close: () => ws.readyState === 1 && ws.close(),
						abort: () => ws.readyState === 1 && ws.close()
					})).catch(() => { });
				}
			})).catch(() => { });

			return new Response(null, {
				status: 101,
				webSocket: client
			});
		}

		return new Response("Hello World", { status: 200 });
	}
};

// 优化：直接连接函数
async function connectDirect(hostname, port) {
	const conn = connect({ hostname, port });
	await conn.opened;
	return conn;
}

function getSKJson(path) {
	if (!path.includes('@')) return null;

	const [cred, server] = path.split('@');
	const [user, pass] = cred.split(':');
	const [host, port = 443] = server.split(':');
	// 使用预定义的TextEncoder
	const userEncoded = user ? te.encode(user) : null;
	const passEncoded = pass ? te.encode(pass) : null;
	return {
		user,
		pass,
		host,
		port: +port,
		userEncoded,
		passEncoded
	};
}

// 优化getOrder函数 - 使用缓存避免重复创建数组
const orderCache = {
	'p': ['d', 'p'],
	's': ['d', 's'],
	'g': ['s'],
	'default': ['d']
};

function getOrder(mode) {
	return orderCache[mode] || orderCache['default'];
}

// SK连接
async function sConnect(targetHost, targetPort, skJson) {
	const conn = connect({
		hostname: skJson.host,
		port: skJson.port
	});
	await conn.opened;
	const w = conn.writable.getWriter();
	const r = conn.readable.getReader();
	await w.write(new Uint8Array([5, 2, 0, 2]));
	const auth = (await r.read()).value;
	if (auth[1] === 2 && skJson.user) {
		// 使用预编码的凭证
		await w.write(new Uint8Array([1, skJson.userEncoded.length, ...skJson.userEncoded, skJson.passEncoded.length, ...skJson.passEncoded]));
		await r.read();
	}
	const domain = te.encode(targetHost); // 使用预定义的TextEncoder
	await w.write(new Uint8Array([5, 1, 0, 3, domain.length, ...domain, targetPort >> 8,
		targetPort & 0xff
	]));
	await r.read();
	w.releaseLock();
	r.releaseLock();
	return conn;
};
