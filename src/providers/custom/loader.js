/**
 * 自定义 Provider 加载器
 * 导入时复制文件到 userData/custom-providers/，避免源文件被删后失效。
 * 删除时同时清理配置文件中的记录和复制到 userData 下的副本。
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 渲染进程无法访问 electron.app（app 为 undefined），但页面内的自动解析/发送需要
// 自定义 Provider 的方法（isResponseComplete 等），不能只靠内置 Provider。
// 渲染进程的 userData 路径由主进程在创建窗口时经 additionalArguments 注入
// （--cuckoo-user-data=），据此读取配置并加载自定义 Provider。
function isRendererProcess() {
  return process.type === 'renderer';
}

// 缓存：完成检测轮询等高频路径每 2s 调用一次 loadCustomProviders，避免反复 require 与刷屏
let customProviderCache = null;
function invalidateCustomProviderCache() {
  customProviderCache = null;
}

const CUSTOM_CONFIG_FILE = 'custom-providers.json';
const CUSTOM_PROVIDERS_DIR = 'custom-providers';

function getUserDataPath() {
  if (!isRendererProcess() && app && typeof app.getPath === 'function') {
    return app.getPath('userData');
  }
  const arg = (process.argv || []).find((a) => a.startsWith('--cuckoo-user-data='));
  return arg ? arg.slice('--cuckoo-user-data='.length) : null;
}

function getConfigPath() {
  const base = getUserDataPath();
  return base ? path.join(base, CUSTOM_CONFIG_FILE) : null;
}

function getCustomProvidersDir() {
  const base = getUserDataPath();
  return base ? path.join(base, CUSTOM_PROVIDERS_DIR) : null;
}

function ensureCustomProvidersDir() {
  if (isRendererProcess()) return null;
  const dir = getCustomProvidersDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function readConfig() {
  try {
    const file = getConfigPath();
    if (!file) return { paths: [] };
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (err) {
    console.error('[CustomProvider] 读取配置失败:', err.message);
  }
  return { paths: [] };
}

function writeConfig(config) {
  if (isRendererProcess()) return;
  try {
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), 'utf-8');
  } catch (err) {
    console.error('[CustomProvider] 写入配置失败:', err.message);
  }
}

function validateProvider(p) {
  if (!p || typeof p !== 'object') return '必须是对象';
  if (!p.id || typeof p.id !== 'string') return '缺少 id';
  if (!p.name || typeof p.name !== 'string') return '缺少 name';
  if (!p.homeUrl || typeof p.homeUrl !== 'string') return '缺少 homeUrl';
  if (typeof p.matchesUrl !== 'function') return '缺少 matchesUrl 方法';
  if (typeof p.extractSessionId !== 'function') return '缺少 extractSessionId 方法';
  return null;
}

function loadProviderFromFile(filePath) {
  const provider = require(filePath);
  const error = validateProvider(provider);
  if (error) throw new Error(error);
  return provider;
}

function loadCustomProviders() {
  if (customProviderCache) return customProviderCache;
  const config = readConfig();
  const providers = [];
  for (const p of config.paths || []) {
    try {
      if (!fs.existsSync(p)) {
        console.warn('[CustomProvider] 文件不存在，跳过:', p);
        continue;
      }
      const provider = require(p);
      const error = validateProvider(provider);
      if (error) {
        console.warn('[CustomProvider] 校验失败:', p, error);
        continue;
      }
      provider._customPath = p;
      providers.push(provider);
      console.log('[CustomProvider] 已加载:', provider.id, '来自', p);
    } catch (err) {
      console.error('[CustomProvider] 加载失败:', p, err.message);
    }
  }
  customProviderCache = providers;
  return providers;
}

/**
 * 导入自定义 Provider 文件
 * @param {string} sourcePath 用户选择的源文件路径
 * @param {{ replace?: boolean }} options
 * @returns {{ exists: true, provider: object, targetPath: string } | { success: true, provider: object, targetPath: string }}
 */
function importCustomProvider(sourcePath, options = {}) {
  const provider = loadProviderFromFile(sourcePath);
  const dir = ensureCustomProvidersDir();
  const targetPath = path.join(dir, provider.id + '.js');

  // 已存在且未要求替换
  if (fs.existsSync(targetPath) && !options.replace) {
    return { exists: true, targetPath, provider };
  }

  // 清理 require 缓存，确保替换后重新加载
  if (fs.existsSync(targetPath)) {
    try {
      delete require.cache[require.resolve(targetPath)];
    } catch (err) {
      // ignore
    }
  }

  // 复制到 userData/custom-providers/
  fs.copyFileSync(sourcePath, targetPath);

  // 写配置（导入/替换都会改变 provider 集合，无条件失效缓存）
  const config = readConfig();
  if (!config.paths) config.paths = [];
  invalidateCustomProviderCache();
  if (!config.paths.includes(targetPath)) {
    config.paths.push(targetPath);
  }
  writeConfig(config);

  return { success: true, targetPath, provider };
}

/**
 * 替换自定义 Provider
 * @param {string} targetProviderId 旧 provider 的 id
 * @param {string} newSourcePath 新文件路径
 * @returns {{ success: true, targetPath, provider }}
 * @throws {Error} 新文件 id 与旧 id 不一致时抛错
 */
function replaceCustomProvider(targetProviderId, newSourcePath) {
  const newProvider = loadProviderFromFile(newSourcePath);
  if (newProvider.id !== targetProviderId) {
    throw new Error(
      '新文件的 id 为 "' + newProvider.id + '"，但当前 Provider 的 id 是 "' +
      targetProviderId + '"，id 必须一致才能替换'
    );
  }
  return importCustomProvider(newSourcePath, { replace: true });
}

/**
 * 删除自定义 Provider
 * 同时从配置移除路径，并删除复制到 userData/custom-providers/ 下的文件。
 */
function removeCustomProviderPath(filePath) {
  const config = readConfig();
  config.paths = (config.paths || []).filter(p => p !== filePath);
  writeConfig(config);

  const dir = getCustomProvidersDir();
  if (filePath && filePath.startsWith(dir + path.sep) && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      console.log('[CustomProvider] 已删除文件:', filePath);
    } catch (err) {
      console.error('[CustomProvider] 删除文件失败:', filePath, err.message);
    }
  }
  invalidateCustomProviderCache();
}

module.exports = {
  invalidateCustomProviderCache,
  loadCustomProviders,
  importCustomProvider,
  replaceCustomProvider,
  removeCustomProviderPath,
  readConfig,
};
