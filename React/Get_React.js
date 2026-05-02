// ==UserScript==
// @name         Get_React
// @namespace    https://github.com/0xsdeo/Hook_JS
// @version      v0.1
// @description  获取React Router路由列表（DOM监控版 - 适用于油猴脚本）
// @author       0xsdeo
// @run-at       document-start
// @match        *://*/*
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ===== 全局执行锁，防止脚本重复运行 =====
    const LOCK_KEY = '__REACT_GETTER_RUNNING__';
    if (window[LOCK_KEY]) {
        console.warn('⚠️ React路由获取脚本已在运行中，跳过本次执行');
        return;
    }
    try {
        Object.defineProperty(window, LOCK_KEY, {
            value: true,
            writable: false,
            configurable: false
        });
    } catch (e) {
        console.warn('⚠️ 无法设置执行锁，脚本可能已在运行');
        return;
    }

    let observer = null;
    let allTimeoutIds = [];
    let hasOutputResult = false;

    // ===== 工具函数：路径拼接 =====
    function joinPath(base, path) {
        if (path === undefined || path === null || path === '') return base || '/';
        if (typeof path !== 'string') return base || '/';
        if (path.startsWith('/')) return path;
        if (!base || base === '/') return '/' + path;
        const cleanBase = base.endsWith('/') ? base.slice(0, -1) : base;
        return cleanBase + '/' + path;
    }

    // ===== Phase 1: DOM层BFS扫描，寻找React挂载节点 =====
    // React在调用 createRoot(domNode) 或 ReactDOM.render() 后，
    // 会在挂载的DOM节点上注入一个带随机后缀的内部属性
    function findReactContainers() {
        if (!document.body) return [];

        const results = [];
        const queue = [document.body];
        const visited = new Set();

        while (queue.length > 0) {
            const node = queue.shift();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            if (node.nodeType !== 1) continue; // 只处理元素节点

            // 用 for...in 检测React内部挂载属性
            // React 18 createRoot: __reactContainer$<randomKey>
            // 某些版本:            __reactContainere$<randomKey>（多一个e）
            // React 17 render:     _reactRootContainer
            for (let prop in node) {
                if (
                    prop.startsWith('__reactContainer$') ||
                    prop.startsWith('__reactContainere$') ||
                    prop === '_reactRootContainer'
                ) {
                    results.push({ node, prop, value: node[prop] });
                    break; // 一个节点只需找到一个挂载属性
                }
            }

            for (let i = 0; i < node.childNodes.length; i++) {
                queue.push(node.childNodes[i]);
            }
        }

        if (results.length > 0) {
            results.forEach(r => console.log(`[AntiDebug] 检测到React挂载节点：${r.prop} on`, r.node));
        }
        return results;
    }

    // ===== 从容器信息中取得Fiber树的起始节点 =====
    // 注意：__reactContainer$xxx 返回的是 HostRoot Fiber 本身（不是 FiberRoot！）
    // 因为 React 源码中 markContainerAsRoot(root.current, container)
    // 传入的是 root.current（HostRoot Fiber），而非 root（FiberRoot）
    //
    // 因此直接取 .child 即可得到第一个真实组件 Fiber，
    // 不能取 .current.child（Fiber 节点没有 .current 属性，那是 FiberRoot 的属性）
    function getStartFiber(containerInfo) {
        try {
            if (containerInfo.prop === '_reactRootContainer') {
                // React 版本差异导致结构不同，需两种都尝试：
                //
                // 方式A（React 17 常见结构）：
                //   _reactRootContainer = { _internalRoot: FiberRoot }
                //   FiberRoot.current = HostRoot Fiber
                //   HostRoot Fiber.child = 第一个组件 Fiber
                const fiberA = containerInfo.value?._internalRoot?.current?.child;
                if (fiberA) {
                    console.log('[AntiDebug] _reactRootContainer（方式A _internalRoot）startFiber:', fiberA);
                    return fiberA;
                }

                // 方式B（旧版React / 某些构建）：
                //   _reactRootContainer = FiberRoot（直接带 .current）
                //   FiberRoot.current = HostRoot Fiber
                //   HostRoot Fiber.child = 第一个组件 Fiber
                const fiberB = containerInfo.value?.current?.child;
                if (fiberB) {
                    console.log('[AntiDebug] _reactRootContainer（方式B 直接current）startFiber:', fiberB);
                    return fiberB;
                }

                console.warn('[AntiDebug] _reactRootContainer 结构未识别:', containerInfo.value);
                return null;
            }

            // React 18: __reactContainer$xxx = HostRoot Fiber（不是FiberRoot！）
            //
            // 关键：__reactContainer$xxx 只在 createRoot 时被赋值一次。
            // 每次 render 提交后，React 会交换双缓冲区，FiberRoot.current 始终
            // 指向最新提交的树，而 __reactContainer$xxx 原来指向的 fiber 可能
            // 已变成 alternate（备用），其 .child 可能为 null。
            //
            // 正确路径：.stateNode（→FiberRoot）.current（→已提交的HostRoot）.child
            const fiberRoot = containerInfo.value?.stateNode;
            const fiberA = fiberRoot?.current?.child;
            if (fiberA) {
                console.log('[AntiDebug] React 18 startFiber（via stateNode.current）:', fiberA);
                return fiberA;
            }
            // 兜底：直接取 .child（极少数情况下 alternate 上也有数据）
            const fiberB = containerInfo.value?.child || null;
            console.log('[AntiDebug] React 18 startFiber（via direct child）:', fiberB);
            return fiberB;
        } catch (e) {
            console.warn('[AntiDebug] getStartFiber 出错:', e);
            return null;
        }
    }

    // ===== RouterProvider模式检测（v6 data router）=====
    // 对应 React Router v6 的 createBrowserRouter + <RouterProvider router={router} />
    // v6 data router 有专属方法 navigate / subscribe，v3/v4 router 没有
    function isRouterProvider(props) {
        if (!props || typeof props !== 'object') return false;
        const router = props.router;
        if (!router || typeof router !== 'object') return false;
        if (!Array.isArray(router.routes)) return false;
        // v6 data router 必有 navigate 方法；v3/v4 router 没有（用 push/transitionTo）
        // 这是区分两者最可靠的特征
        if (typeof router.navigate !== 'function') return false;
        if (router.routes.length === 0) return true;
        return router.routes.some(r =>
            r && typeof r === 'object' && ('path' in r || 'children' in r || 'id' in r)
        );
    }

    // ===== 判断一个 router 对象是否为 v3/v4 style（history-like）=====
    function isLegacyRouterObject(router) {
        if (!router || typeof router !== 'object') return false;
        if (!Array.isArray(router.routes) || router.routes.length === 0) return false;
        // v3/v4 router 的专属方法
        if (typeof router.getCurrentLocation === 'function' ||
            typeof router.transitionTo === 'function' ||
            typeof router.listenBefore === 'function') {
            return true;
        }
        // 或者 routes 数组中含有 v3/v4 专有字段
        return router.routes.some(r =>
            r && typeof r === 'object' && ('childRoutes' in r || 'getComponent' in r || 'indexRoute' in r)
        );
    }

    // ===== React Router v3/v4 Legacy 模式检测 =====
    // 两种存放位置：
    //   1. props.routes（直接是路由数组）
    //   2. props.router.routes（routes 挂在 history-like 的 router 对象上）
    function isLegacyRouterRoutes(props) {
        if (!props || typeof props !== 'object') return false;

        // Case 1: props.routes 直接是路由数组
        if (Array.isArray(props.routes) && props.routes.length > 0) {
            if (props.routes.some(r =>
                r && typeof r === 'object' && 'path' in r &&
                ('component' in r || 'getComponent' in r || 'childRoutes' in r || 'indexRoute' in r)
            )) return true;
        }

        // Case 2: props.router 是 v3/v4 history-like router，routes 在其上
        if (isLegacyRouterObject(props.router)) return true;

        return false;
    }

    // ===== 从检测到的 props 中提取 v3/v4 routes 数组 =====
    function getLegacyRoutes(props) {
        if (Array.isArray(props.routes) && props.routes.length > 0) return props.routes;
        if (isLegacyRouterObject(props.router)) return props.router.routes;
        return [];
    }

    // ===== JSX <Routes>/<Route> 模式检测 =====
    // 对应 React Router v5/v6 的 JSX 写法：<Routes><Route path="/" element={...} /></Routes>
    // 路由信息分散在各个 React Element 的 props 里
    function isRouteElement(el) {
        if (!el || typeof el !== 'object') return false;
        const p = el.props;
        if (!p || typeof p !== 'object') return false;
        // 必须有 path（字符串）或 index（布尔，代表默认子路由）
        const hasPath = typeof p.path === 'string';
        const hasIndex = p.index === true;
        if (!hasPath && !hasIndex) return false;
        // 必须同时具备 element / component / render / children 之一
        // 防止把带有 path prop 的普通组件（Link、面包屑等）误判为 Route
        return (
            p.element !== undefined ||
            typeof p.component === 'function' ||
            typeof p.render === 'function' ||
            p.children !== undefined
        );
    }

    function isRoutesComponent(props) {
        if (!props || typeof props !== 'object') return false;
        const children = props.children;
        if (!children) return false;
        const subs = Array.isArray(children) ? children : [children];
        const nonNull = subs.filter(s => s !== null && s !== undefined);
        if (nonNull.length === 0) return false;
        return nonNull.every(sub =>
            isRouteElement(sub) ||
            (Array.isArray(sub) && sub.length > 0 && sub.every(isRouteElement))
        );
    }

    // ===== Phase 2: Fiber树BFS扫描，寻找Router实例 =====
    // 导航策略：只沿 child 和 sibling 前进，绝不将 alternate 加入队列。
    // 额外读取 fiber.alternate 的 props（不遍历其子树），
    // 应对路由数据仅存在于 alternate fiber 上的情况。
    //
    // 返回优先级策略（从高到低）：
    //   RouterProvider → 立即返回（最可靠，特征极明确）
    //   LegacyRoutes   → 立即返回（可靠，有 routes 数组且带框架特有字段）
    //   JSX Routes     → 仅作候选，继续扫完整棵树后若无更好结果才返回
    //                   （最易误判，普通组件的 children 也可能满足条件）
    function findRouterInFiber(startFiber) {
        if (!startFiber) return null;

        const queue = [startFiber];
        const visited = new WeakSet();
        const MAX_NODES = 3000;
        let count = 0;
        let jsxRoutesCandidate = null; // JSX Routes 命中时不立刻返回，保存为候选

        while (queue.length > 0 && count < MAX_NODES) {
            const fiber = queue.shift();
            count++;

            if (!fiber || typeof fiber !== 'object') continue;
            if (visited.has(fiber)) continue;
            visited.add(fiber);

            // 收集需要检测的 props 来源：
            // 1. 当前 fiber 的 memoizedProps / pendingProps
            // 2. alternate fiber 的 memoizedProps / pendingProps
            //    （路由数据有时仅存于 alternate，不加入队列只读其 props）
            const propsSources = [fiber.memoizedProps, fiber.pendingProps];
            const alt = fiber.alternate;
            if (alt && alt !== fiber && !visited.has(alt)) {
                propsSources.push(alt.memoizedProps, alt.pendingProps);
            }

            for (const props of propsSources) {
                if (!props || typeof props !== 'object') continue;

                // RouterProvider：立即返回，特征最明确
                if (isRouterProvider(props)) {
                    return { type: 'RouterProvider', router: props.router };
                }
                // LegacyRoutes：立即返回，v3/v4 特有结构
                if (isLegacyRouterRoutes(props)) {
                    return { type: 'LegacyRoutes', routes: getLegacyRoutes(props) };
                }
                // JSX Routes：仅保存第一个命中，继续扫描不返回
                // 避免因浅层误判提前退出，错过更深处的真实路由
                if (!jsxRoutesCandidate && isRoutesComponent(props)) {
                    jsxRoutesCandidate = { type: 'Routes', props };
                }
            }

            // 严格只走Fiber树导航链路
            if (fiber.child) queue.push(fiber.child);
            if (fiber.sibling) queue.push(fiber.sibling);
        }

        if (count >= MAX_NODES) {
            console.warn('[AntiDebug] ⚠️ Fiber树遍历达到上限（3000节点），可能未完整扫描');
        } else if (!jsxRoutesCandidate) {
            console.log(`[AntiDebug] Fiber树遍历完毕，共访问 ${count} 个节点，未找到Router`);
        }

        // RouterProvider / LegacyRoutes 未找到，用 JSX Routes 候选兜底（可能为误判）
        return jsxRoutesCandidate || null;
    }

    // ===== 路由提取：React Router v3/v4 Legacy 模式 =====
    // 路由结构：{ path, name, component/getComponent, childRoutes, indexRoute }
    // 子路由字段是 childRoutes（不是 children）
    function extractLegacyRoutes(routes, prefix) {
        prefix = prefix || '';
        const list = [];
        if (!Array.isArray(routes)) return list;

        for (const route of routes) {
            if (!route || typeof route !== 'object') continue;
            if (typeof route.path !== 'string') continue;

            const fullPath = joinPath(prefix, route.path);
            list.push({
                name: route.name || '(unnamed)',
                path: fullPath
            });

            // 递归处理 childRoutes（v3/v4 的嵌套路由字段）
            if (Array.isArray(route.childRoutes) && route.childRoutes.length > 0) {
                list.push(...extractLegacyRoutes(route.childRoutes, fullPath));
            }
        }
        return list;
    }

    // ===== 路由提取：RouterProvider模式 =====
    // routes 数组结构：{ path, id, children, element, hasErrorBoundary }
    function extractRouterProviderRoutes(routes, prefix) {
        prefix = prefix || '';
        const list = [];
        if (!Array.isArray(routes)) return list;

        for (const route of routes) {
            if (!route || typeof route !== 'object') continue;
            const fullPath = joinPath(prefix, route.path);
            list.push({
                name: route.id !== undefined ? String(route.id) : '(unnamed)',
                path: fullPath
            });
            // 递归处理子路由
            if (Array.isArray(route.children) && route.children.length > 0) {
                list.push(...extractRouterProviderRoutes(route.children, fullPath));
            }
        }
        return list;
    }

    // ===== 路由提取：JSX Routes模式 =====
    // 从 React Element 树的 props.children 中递归提取 path
    function extractJSXRoutes(props, prefix) {
        prefix = prefix || '';
        const list = [];
        if (!props || !props.children) return list;

        const subs = Array.isArray(props.children) ? props.children : [props.children];
        for (const sub of subs) {
            if (!sub || typeof sub !== 'object') continue;
            const p = sub.props;
            if (!p) continue;

            const fullPath = joinPath(prefix, p.path);
            if (typeof p.path === 'string') {
                list.push({ name: '', path: fullPath });
            }
            // 递归处理嵌套 Route
            if (p.children) {
                list.push(...extractJSXRoutes(p, fullPath));
            }
        }
        return list;
    }

    // ===== 检测路由模式（browser / hash / memory） =====
    function detectRouterMode(router) {
        try {
            const ctorName = router.history?.constructor?.name || '';
            if (ctorName.toLowerCase().includes('hash')) return 'hash';
            if (ctorName.toLowerCase().includes('memory')) return 'memory';
        } catch (e) {}
        if (typeof window.location.hash === 'string' && window.location.hash.startsWith('#/')) {
            return 'hash';
        }
        return 'browser';
    }

    // ===== 主尝试函数：串联两阶段扫描并输出结果 =====
    function tryGetRouter() {
        if (hasOutputResult) return true;

        const containers = findReactContainers();
        if (containers.length === 0) return false;

        let found = false;

        for (const container of containers) {
            const startFiber = getStartFiber(container);
            if (!startFiber) continue;

            const result = findRouterInFiber(startFiber);
            if (!result) continue;

            found = true;

            if (result.type === 'RouterProvider') {
                const mode = detectRouterMode(result.router);
                const routes = extractRouterProviderRoutes(result.router.routes);
                console.log(`\n📋 React Router 路由列表 [RouterProvider - ${mode} 模式]：`);
                console.table(routes.map(r => ({ Name: r.name, Path: r.path })));
                console.log('\n🔗 Router 实例：', result.router);
            } else if (result.type === 'LegacyRoutes') {
                const routes = extractLegacyRoutes(result.routes);
                console.log('\n📋 React Router 路由列表 [v3/v4 Legacy 模式]：');
                console.table(routes.map(r => ({ Name: r.name, Path: r.path })));
                console.log('\n🔗 原始 routes：', result.routes);
            } else {
                const routes = extractJSXRoutes(result.props);
                console.log('\n📋 React Router 路由列表 [JSX <Routes> 模式]：');
                console.table(routes.map(r => ({ Name: r.name || '(unnamed)', Path: r.path })));
            }
        }

        if (found) {
            hasOutputResult = true;
        }

        return found;
    }

    // ===== DOM变化监控（MutationObserver） =====
    // 用于应对 React 懒加载场景，在DOM发生变化时补扫
    function startDOMObserver() {
        // 立即尝试一次
        if (tryGetRouter()) {
            cleanupResources();
            return;
        }

        observer = new MutationObserver(() => {
            if (hasOutputResult) return;
            if (tryGetRouter()) {
                cleanupResources();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ===== 清理资源 =====
    function cleanupResources() {
        hasOutputResult = true;
        allTimeoutIds.forEach(id => clearTimeout(id));
        allTimeoutIds = [];
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    // ===== 指数退避轮询（兜底机制） =====
    // React 挂载时机不固定，用轮询保证不遗漏
    // 共尝试6次，间隔：200ms → 400ms → 800ms → 1600ms → 3200ms → 6400ms
    function startPollingRetry() {
        let delay = 200;
        let remainingTries = 6;

        function poll() {
            if (hasOutputResult) return;

            if (tryGetRouter()) {
                cleanupResources();
                return;
            }

            if (remainingTries > 0) {
                remainingTries--;
                const id = setTimeout(poll, delay);
                allTimeoutIds.push(id);
                delay *= 2;
            } else {
                console.log('❌ 未找到React Router实例（已重试多次，请确认站点是否使用React Router）');
                cleanupResources();
            }
        }

        const id = setTimeout(poll, 200);
        allTimeoutIds.push(id);
    }

    // ===== 入口函数 =====
    // Vue脚本在 DOMContentLoaded 后就开始扫描，
    // 但React通常在此之后才挂载，因此需等到 load 事件（页面资源全部加载完毕）
    function init() {
        if (document.readyState === 'complete') {
            // 页面已完全加载，立即开始
            startDOMObserver();
            startPollingRetry();
        } else {
            window.addEventListener('load', function () {
                startDOMObserver();
                startPollingRetry();
            });
        }
    }

    init();

})();
