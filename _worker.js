import { connect } from 'cloudflare:sockets';
let 反代IP = 'sjc.o00o.ooo'
export default {
  async fetch(访问请求) {
    const url = new URL(访问请求.url);
    反代IP = url.searchParams.get('ip') || 反代IP;
    if (访问请求.headers.get('Upgrade') === 'websocket') {
      return await 升级WS请求(访问请求)
    } else {
      return new Response(null, { status: 400 })
    }
  }
};
////////////////////////////////////////////////////////////////////////脚本主要架构//////////////////////////////////////////////////////////////////////
//第一步，读取和构建基础访问结构
async function 升级WS请求(访问请求) {
  const 原始协议头 = 访问请求.headers.get('sec-websocket-protocol') || '';
  const 协议标头列表 = 原始协议头.split(',').map(item => item.trim()).filter(Boolean);
  const 读取我的加密访问内容数据头 = (协议标头列表.find(item => item.length >= 16 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(item)) ?? 协议标头列表[0]); //读取访问标头中的WS通信数据
  if (!读取我的加密访问内容数据头) {
    return new Response('缺少认证信息', { status: 400 });
  }
  let 解密数据;
  try {
    解密数据 = 使用64位加解密(读取我的加密访问内容数据头); //解密目标访问数据，传递给TCP握手进程
  } catch {
    return new Response('认证信息无效', { status: 400 });
  }
  const 创建WS接口 = new WebSocketPair();
  const [客户端, WS接口] = Object.values(创建WS接口);
  const 结果 = await 解析VL标头(解密数据, WS接口); //解析VL数据并进行TCP握手
  if (结果 instanceof Response) {
    return 结果; //如果解析失败，返回错误响应
  }
  return new Response(null, { status: 101, webSocket: 客户端 }); //一切准备就绪后，回复客户端WS连接升级成功
}
function 使用64位加解密(还原混淆字符) {
  if (typeof 还原混淆字符 !== 'string' || 还原混淆字符.length === 0) {
    throw new Error('Invalid base64 input');
  }
  还原混淆字符 = 还原混淆字符.replace(/-/g, '+').replace(/_/g, '/');
  const 解密数据 = atob(还原混淆字符);
  const 解密_你_个_丁咚_咙_咚呛 = Uint8Array.from(解密数据, (c) => c.charCodeAt(0));
  return 解密_你_个_丁咚_咙_咚呛.buffer;
}
//第二步，解读VL协议数据，创建TCP握手
let 访问地址, 访问端口;
async function 解析VL标头(VL数据, WS接口, TCP接口) {
  const 获取数据定位 = new Uint8Array(VL数据)[17];
  const 提取端口索引 = 18 + 获取数据定位 + 1;
  const 建立端口缓存 = VL数据.slice(提取端口索引, 提取端口索引 + 2);
  访问端口 = new DataView(建立端口缓存).getUint16(0);
  const 提取地址索引 = 提取端口索引 + 2;
  const 建立地址缓存 = new Uint8Array(VL数据.slice(提取地址索引, 提取地址索引 + 1));
  const 识别地址类型 = 建立地址缓存[0];
  let 地址长度 = 0;
  let 地址信息索引 = 提取地址索引 + 1;
  switch (识别地址类型) {
    case 1:
      地址长度 = 4;
      访问地址 = new Uint8Array(VL数据.slice(地址信息索引, 地址信息索引 + 地址长度)).join('.');
      break;
    case 2:
      地址长度 = new Uint8Array(VL数据.slice(地址信息索引, 地址信息索引 + 1))[0];
      地址信息索引 += 1;
      访问地址 = new TextDecoder().decode(VL数据.slice(地址信息索引, 地址信息索引 + 地址长度));
      break;
    case 3:
      地址长度 = 16;
      const dataView = new DataView(VL数据.slice(地址信息索引, 地址信息索引 + 地址长度));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) { ipv6.push(dataView.getUint16(i * 2).toString(16)); }
      访问地址 = ipv6.join(':');
      break;
    default:
      return new Response('无效的访问地址', { status: 400 });
  }
  const 写入初始数据 = VL数据.slice(地址信息索引 + 地址长度);
  try {
    TCP接口 = connect({ hostname: 访问地址, port: 访问端口 });
    await TCP接口.opened;
  } catch {
    let [反代IP地址, 反代IP端口] = 反代IP.split(':');
    TCP接口 = connect({ hostname: 反代IP地址, port: 反代IP端口 || 访问端口 });
  }
  try {
    await TCP接口.opened;
  } catch {
    return new Response('连接握手失败', { status: 400 });
  }
  建立传输管道(WS接口, TCP接口, 写入初始数据); //建立WS接口与TCP接口的传输管道
}
//第三步，创建客户端WS-CF-目标的传输通道并监听状态
async function 建立传输管道(WS接口, TCP接口, 写入初始数据, 写入队列 = Promise.resolve(), 回写队列 = Promise.resolve()) {
  let 累计接收字节数 = 0;
  let 已清理资源 = false;
  const 总数据阶梯延迟 = [
    { size: 1 * 1024 * 1024, delay: 320 },
    { size: 50 * 1024 * 1024, delay: 340 },
    { size: 100 * 1024 * 1024, delay: 360 },
    { size: 200 * 1024 * 1024, delay: 400 },
  ];
  function 获取当前总延迟() {
    return (总数据阶梯延迟.slice().reverse().find(({ size }) => 累计接收字节数 >= size) ?? { delay: 300 }).delay;
  }
  WS接口.accept();
  WS接口.send(new Uint8Array([0, 0]));
  const 传输数据 = TCP接口.writable.getWriter();
  const 读取数据 = TCP接口.readable.getReader();
  if (写入初始数据) 写入队列 = 写入队列.then(() => 传输数据.write(写入初始数据)).catch(); //向TCP接口推送标头中提取的初始访问数据
  WS接口.addEventListener('message', event => 写入队列 = 写入队列.then(() => 传输数据.write(event.data)).catch());
  启动回传();
  async function 启动回传() {
    let 字节计数 = 0;
    try {
      while (!已清理资源) {
        const { done: 流结束, value: 返回数据 } = await 读取数据.read();
        if (流结束) {
          await 清理资源();
          break;
        }
        if (返回数据.length > 0) {
          累计接收字节数 += 返回数据.length;
          回写队列 = 回写队列.then(() => WS接口.send(返回数据)).catch();
          if ((累计接收字节数 - 字节计数) > 4 * 1024 * 1024) {
            await new Promise(resolve => setTimeout(resolve, 获取当前总延迟() + 500));
            字节计数 = 累计接收字节数;
          }
        }
      }
    } catch (err) {
      await 清理资源();
    }
  }
  async function 清理资源() {
    if (已清理资源) return;
    已清理资源 = true;
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      WS接口.close(1000);
      await TCP接口.close?.();
    } catch { };
  }
}
