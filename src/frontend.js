import { htmlTemplate } from './templates/landing.html.js';
import { cssStyles } from './templates/landing.css.js';

const escapeHtml = (value = '') =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildRawString = (strings, ...values) => {
  const parts = strings && strings.raw ? strings.raw : strings;
  let output = '';
  for (let i = 0; i < parts.length; i += 1) {
    output += parts[i];
    if (i < values.length) {
      output += values[i];
    }
  }
  return output;
};

const pageScript = buildRawString`
(() => {
  'use strict';

  // Glow effect: mouse tracking + auto wandering
  let mouseIdleTimer = null;
  let isAutoGlow = true;
  let glowAnimationFrame = null;
  let currentGlowX = 0.5;
  let currentGlowY = 0;
  let targetGlowX = 0.5;
  let targetGlowY = 0;
  let lastFrameTime = Date.now();
  let isResting = false;
  let restStartTime = 0;

  // 鼠标采样系统
  let lastMouseSampleTime = 0;
  const MOUSE_SAMPLE_INTERVAL = 1000; // 每1秒采样一次鼠标位置
  let latestMouseX = 0;
  let latestMouseY = 0;

  // 呼吸动画系统（随机亮度 + 随机周期）
  const getRandomBreatheMin = () => 0.5 + Math.random() * 0.2; // 0.5-0.7
  const getRandomBreatheMax = () => 1.0 + Math.random() * 0.2; // 1.0-1.2
  const getRandomBreatheDuration = () => 2 + Math.random() * 10; // 2-12 秒一个呼吸周期
  let breathePhase = Math.random();
  let breatheCycleDuration = getRandomBreatheDuration();
  let breatheMinOpacity = getRandomBreatheMin();
  let breatheMaxOpacity = getRandomBreatheMax();
  let targetBreatheCycleDuration = breatheCycleDuration;
  let targetBreatheMinOpacity = breatheMinOpacity;
  let targetBreatheMaxOpacity = breatheMaxOpacity;
  const BREATHE_SMOOTHING_SPEED = 1.8; // 调整目标亮度/周期的平滑速度（越大越快）

  // 页面可见性管理
  let visibilityTimer = null;
  let isRenderingStopped = false;
  let fadeInPhase = 1; // 淡入进度 0-1
  const FADE_IN_DURATION = 2.5; // 2.5秒淡入
  const syncBreatheOpacity = () => {
    const body = document.body;
    if (!body) return;
    const breatheValue = 0.5 + 0.5 * Math.sin(breathePhase * Math.PI * 2 - Math.PI / 2);
    const currentOpacity = breatheMinOpacity + (breatheMaxOpacity - breatheMinOpacity) * breatheValue;
    body.style.setProperty('--breathe-opacity', (currentOpacity * fadeInPhase).toFixed(3));
  };

  // 颜色渐变系统
  const colorTable = [
    { r: 62, g: 110, b: 255 },   // 当前蓝色
    { r: 0, g: 191, b: 255 },    // 深天蓝 DeepSkyBlue
    { r: 64, g: 224, b: 208 },   // 青绿 Turquoise
    { r: 138, g: 43, b: 226 },   // 蓝紫 BlueViolet
    { r: 147, g: 51, b: 234 },   // 紫色 Purple
    { r: 199, g: 21, b: 133 },   // 深粉 MediumVioletRed
    { r: 255, g: 20, b: 147 },   // 玫红 DeepPink
    { r: 72, g: 61, b: 139 },    // 深蓝紫 DarkSlateBlue
  ];
  const getRandomColorIndex = () => Math.floor(Math.random() * colorTable.length);
  const getNextColorIndex = (excludeIndex) => {
    if (colorTable.length <= 1) return excludeIndex;
    let nextIndex = getRandomColorIndex();
    while (nextIndex === excludeIndex) {
      nextIndex = getRandomColorIndex();
    }
    return nextIndex;
  };
  let currentColorIndex = getRandomColorIndex();
  let targetColorIndex = getNextColorIndex(currentColorIndex);
  const getRandomColorTransitionDuration = () => 10 + Math.random() * 35; // 10-45秒渐变
  let colorTransitionPhase = Math.random();
  let colorTransitionDuration = getRandomColorTransitionDuration();
  const applyGlowColor = () => {
    const body = document.body;
    if (!body) return;
    const currentColor = colorTable[currentColorIndex] || colorTable[0];
    const targetColor = colorTable[targetColorIndex] || currentColor;
    const r = Math.round(currentColor.r + (targetColor.r - currentColor.r) * colorTransitionPhase);
    const g = Math.round(currentColor.g + (targetColor.g - currentColor.g) * colorTransitionPhase);
    const b = Math.round(currentColor.b + (targetColor.b - currentColor.b) * colorTransitionPhase);
    body.style.setProperty('--glow-r', r);
    body.style.setProperty('--glow-g', g);
    body.style.setProperty('--glow-b', b);
  };

  // 速度系统
  const MAX_SPEED = 0.08; // 每秒最多移动 8% 的屏幕宽度（很慢）
  const WANDER_ACCELERATION = 0.12; // 自动游走的加速度系数
  const MOUSE_ACCELERATION = 0.04; // 鼠标跟随的加速度系数（更慢更柔和）
  const WANDER_REACHED_THRESHOLD = 0.01; // 到达目标的阈值（1%）
  let currentRestDuration = Math.random() * 8000; // 随机 0-8 秒休息时间

  let currentSpeedX = 0; // 当前X方向速度
  let currentSpeedY = 0; // 当前Y方向速度

  // 更新UI元素（按钮和事件日志）的边缘辉光
  const updateElementsEdgeGlow = (glowX, glowY) => {
    const w = window.innerWidth;
    const h = window.innerHeight;

    // 获取所有需要边缘辉光的元素
    const elements = document.querySelectorAll('button, .log');

    elements.forEach(element => {
      const rect = element.getBoundingClientRect();

      // 计算光斑相对于元素的位置（百分比）
      const relativeX = ((glowX - rect.left) / rect.width) * 100;
      const relativeY = ((glowY - rect.top) / rect.height) * 100;

      // 计算光斑到元素中心的距离
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = glowX - centerX;
      const dy = glowY - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // 归一化距离（以屏幕对角线的一半为基准）
      const maxDistance = Math.sqrt(w * w + h * h) * 0.5;
      const normalizedDistance = distance / maxDistance;

      // 光照衰减参数
      const ELEMENT_GLOW_RADIUS = 0.4; // 40% 屏幕距离内有效
      const ELEMENT_MAX_INTENSITY = 0.2; // 最大20%强度
      const ELEMENT_REFLECTION_COEFFICIENT = 0.7; // 70% 反射系数

      // 基础光照强度（距离衰减）
      const baseIntensity = Math.max(0, 1 - normalizedDistance / ELEMENT_GLOW_RADIUS) * ELEMENT_MAX_INTENSITY;

      // 计算光斑到元素4个边缘的距离（归一化到元素尺寸）
      const distToTop = Math.abs(glowY - rect.top) / rect.height;
      const distToBottom = Math.abs(glowY - rect.bottom) / rect.height;
      const distToLeft = Math.abs(glowX - rect.left) / rect.width;
      const distToRight = Math.abs(glowX - rect.right) / rect.width;

      // 边缘接近度（越接近边缘，接近度越高）
      const edgeThreshold = 2.0; // 在2倍元素尺寸内才有反射
      const proximityTop = distToTop < edgeThreshold ? Math.pow(1 - distToTop / edgeThreshold, 1.5) : 0;
      const proximityBottom = distToBottom < edgeThreshold ? Math.pow(1 - distToBottom / edgeThreshold, 1.5) : 0;
      const proximityLeft = distToLeft < edgeThreshold ? Math.pow(1 - distToLeft / edgeThreshold, 1.5) : 0;
      const proximityRight = distToRight < edgeThreshold ? Math.pow(1 - distToRight / edgeThreshold, 1.5) : 0;

      // 反射强度 = 基础强度 × 反射系数 × 接近度
      const reflectTop = baseIntensity * ELEMENT_REFLECTION_COEFFICIENT * proximityTop;
      const reflectBottom = baseIntensity * ELEMENT_REFLECTION_COEFFICIENT * proximityBottom;
      const reflectLeft = baseIntensity * ELEMENT_REFLECTION_COEFFICIENT * proximityLeft;
      const reflectRight = baseIntensity * ELEMENT_REFLECTION_COEFFICIENT * proximityRight;

      // 设置元素的辉光位置
      element.style.setProperty('--elem-glow-x', relativeX.toFixed(2) + '%');
      element.style.setProperty('--elem-glow-y', relativeY.toFixed(2) + '%');

      // 设置反射强度
      element.style.setProperty('--elem-reflect-top', reflectTop.toFixed(3));
      element.style.setProperty('--elem-reflect-bottom', reflectBottom.toFixed(3));
      element.style.setProperty('--elem-reflect-left', reflectLeft.toFixed(3));
      element.style.setProperty('--elem-reflect-right', reflectRight.toFixed(3));

      // 计算辉光宽度（只在水平/垂直方向扩散，椭圆的另一维度固定为1px）
      // 上下边缘：水平方向宽度动态变化
      const baseWidth = 10; // 基础宽度 10%
      const maxWidth = 30; // 最大宽度 30%

      const glowHWidthTop = baseWidth + reflectTop * (maxWidth - baseWidth);
      const glowHWidthBottom = baseWidth + reflectBottom * (maxWidth - baseWidth);

      // 左右边缘：垂直方向高度动态变化
      const glowVHeightLeft = baseWidth + reflectLeft * (maxWidth - baseWidth);
      const glowVHeightRight = baseWidth + reflectRight * (maxWidth - baseWidth);

      element.style.setProperty('--elem-glow-h-width-top', glowHWidthTop + '%');
      element.style.setProperty('--elem-glow-h-width-bottom', glowHWidthBottom + '%');
      element.style.setProperty('--elem-glow-v-height-left', glowVHeightLeft + '%');
      element.style.setProperty('--elem-glow-v-height-right', glowVHeightRight + '%');
    });
  };

  const updateGlowPosition = (x, y) => {
    const xPercent = (x / window.innerWidth * 100).toFixed(1);
    const yPercent = (y / window.innerHeight * 100).toFixed(1);
    document.body.style.setProperty('--glow-x', xPercent + '%');
    document.body.style.setProperty('--glow-y', yPercent + '%');
    currentGlowX = x / window.innerWidth;
    currentGlowY = y / window.innerHeight;

    // 计算边缘反射强度（符合物理规律：反射不能超过入射光强度）
    const normalizedX = currentGlowX;
    const normalizedY = currentGlowY;

    // 光晕参数（对应 body::before 中的主光晕）
    const GLOW_MAX_INTENSITY = 0.35; // 主光晕的最大强度
    const GLOW_RADIUS = 0.55; // 光晕半径（对应 transparent 55%）
    const REFLECTION_COEFFICIENT = 0.6; // 反射系数（60% 的光被反射，40% 被吸收）

    // 计算光晕中心到各边缘的距离
    const distanceToTop = normalizedY;
    const distanceToBottom = 1 - normalizedY;
    const distanceToLeft = normalizedX;
    const distanceToRight = 1 - normalizedX;

    // 计算光晕在各边缘的实际强度（径向衰减）
    const glowIntensityAtTop = GLOW_MAX_INTENSITY * Math.max(0, 1 - distanceToTop / GLOW_RADIUS);
    const glowIntensityAtBottom = GLOW_MAX_INTENSITY * Math.max(0, 1 - distanceToBottom / GLOW_RADIUS);
    const glowIntensityAtLeft = GLOW_MAX_INTENSITY * Math.max(0, 1 - distanceToLeft / GLOW_RADIUS);
    const glowIntensityAtRight = GLOW_MAX_INTENSITY * Math.max(0, 1 - distanceToRight / GLOW_RADIUS);

    // 计算边缘接近度（在边缘附近才有反射）
    const edgeThreshold = 0.3; // 在30%范围内才有反射
    const proximityTop = normalizedY < edgeThreshold ? Math.pow(1 - normalizedY / edgeThreshold, 2) : 0;
    const proximityBottom = normalizedY > (1 - edgeThreshold) ? Math.pow((normalizedY - (1 - edgeThreshold)) / edgeThreshold, 2) : 0;
    const proximityLeft = normalizedX < edgeThreshold ? Math.pow(1 - normalizedX / edgeThreshold, 2) : 0;
    const proximityRight = normalizedX > (1 - edgeThreshold) ? Math.pow((normalizedX - (1 - edgeThreshold)) / edgeThreshold, 2) : 0;

    // 反射强度 = 光晕实际强度 × 反射系数 × 接近度
    const reflectTop = glowIntensityAtTop * REFLECTION_COEFFICIENT * proximityTop;
    const reflectBottom = glowIntensityAtBottom * REFLECTION_COEFFICIENT * proximityBottom;
    const reflectLeft = glowIntensityAtLeft * REFLECTION_COEFFICIENT * proximityLeft;
    const reflectRight = glowIntensityAtRight * REFLECTION_COEFFICIENT * proximityRight;

    document.body.style.setProperty('--reflect-top', reflectTop.toFixed(3));
    document.body.style.setProperty('--reflect-bottom', reflectBottom.toFixed(3));
    document.body.style.setProperty('--reflect-left', reflectLeft.toFixed(3));
    document.body.style.setProperty('--reflect-right', reflectRight.toFixed(3));

    // 计算光晕宽度：强度越高，扩散越宽（缩小到 45%）
    // 上下边缘的光晕尺寸
    const glowHWidthTop = 6.75 + reflectTop * 11.25; // 水平宽度：6.75%-18%
    const glowVHeightTop = 18 + reflectTop * 54; // 垂直扩散：18px-72px
    const glowHWidthBottom = 6.75 + reflectBottom * 11.25;
    const glowVHeightBottom = 18 + reflectBottom * 54;

    // 左右边缘的光晕尺寸
    const glowHWidthLeft = 18 + reflectLeft * 54; // 水平扩散：18px-72px
    const glowVHeightLeft = 6.75 + reflectLeft * 11.25; // 垂直宽度：6.75%-18%
    const glowHWidthRight = 18 + reflectRight * 54;
    const glowVHeightRight = 6.75 + reflectRight * 11.25;

    document.body.style.setProperty('--glow-h-width-top', glowHWidthTop + '%');
    document.body.style.setProperty('--glow-v-height-top', glowVHeightTop + 'px');
    document.body.style.setProperty('--glow-h-width-bottom', glowHWidthBottom + '%');
    document.body.style.setProperty('--glow-v-height-bottom', glowVHeightBottom + 'px');
    document.body.style.setProperty('--glow-h-width-left', glowHWidthLeft + 'px');
    document.body.style.setProperty('--glow-v-height-left', glowVHeightLeft + '%');
    document.body.style.setProperty('--glow-h-width-right', glowHWidthRight + 'px');
    document.body.style.setProperty('--glow-v-height-right', glowVHeightRight + '%');

    // 更新 UI 元素（按钮和事件日志）的边缘辉光
    updateElementsEdgeGlow(x, y);
  };

  const getRandomWanderTarget = () => {
    // 在屏幕范围内随机选择一个点
    // 限制在 10%-90% 的范围内，避免太靠边
    return {
      x: 0.1 + Math.random() * 0.8,
      y: 0.05 + Math.random() * 0.2
    };
  };

  const initializeGlowState = () => {
    const initialPosition = getRandomWanderTarget();
    const wanderTarget = getRandomWanderTarget();
    currentGlowX = initialPosition.x;
    currentGlowY = initialPosition.y;
    targetGlowX = wanderTarget.x;
    targetGlowY = wanderTarget.y;
    updateGlowPosition(initialPosition.x * window.innerWidth, initialPosition.y * window.innerHeight);
  };

  const moveTowardsTarget = (currentX, currentY, targetX, targetY, deltaTime, acceleration) => {
    const dx = targetX - currentX;
    const dy = targetY - currentY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < WANDER_REACHED_THRESHOLD) {
      // 到达目标，速度归零
      currentSpeedX = 0;
      currentSpeedY = 0;
      return { x: targetX, y: targetY, reached: true };
    }

    // 计算目标速度方向（单位向量 × 最大速度）
    const targetSpeedX = (dx / distance) * MAX_SPEED;
    const targetSpeedY = (dy / distance) * MAX_SPEED;

    // 平滑过渡到目标速度（使用传入的加速度系数）
    currentSpeedX += (targetSpeedX - currentSpeedX) * acceleration;
    currentSpeedY += (targetSpeedY - currentSpeedY) * acceleration;

    // 应用速度移动
    const moveX = currentSpeedX * deltaTime;
    const moveY = currentSpeedY * deltaTime;
    const newX = currentX + moveX;
    const newY = currentY + moveY;

    // 检查是否会越过目标
    const newDx = targetX - newX;
    const newDy = targetY - newY;
    const newDistance = Math.sqrt(newDx * newDx + newDy * newDy);

    if (newDistance < WANDER_REACHED_THRESHOLD) {
      // 即将到达，直接到达并归零速度
      currentSpeedX = 0;
      currentSpeedY = 0;
      return { x: targetX, y: targetY, reached: true };
    }

    return {
      x: newX,
      y: newY,
      reached: false
    };
  };

  const animateGlow = () => {
    const now = Date.now();
    const deltaTime = (now - lastFrameTime) / 1000;
    lastFrameTime = now;

    const w = window.innerWidth;
    const h = window.innerHeight;

    // 更新淡入效果
    if (fadeInPhase < 1) {
      fadeInPhase += deltaTime / FADE_IN_DURATION;
      fadeInPhase = Math.min(fadeInPhase, 1);
    }

    // 更新颜色渐变
    colorTransitionPhase += deltaTime / colorTransitionDuration;
    if (colorTransitionPhase >= 1) {
      // 到达目标颜色，选择下一个随机目标
      currentColorIndex = targetColorIndex;
      targetColorIndex = getNextColorIndex(currentColorIndex);
      colorTransitionPhase = 0;
      colorTransitionDuration = getRandomColorTransitionDuration();
    }

    applyGlowColor();

    // 更新呼吸动画（随机亮度 + 随机周期）
    const breatheSmoothing =
      deltaTime > 0 ? 1 - Math.exp(-BREATHE_SMOOTHING_SPEED * deltaTime) : 0;
    if (breatheSmoothing > 0) {
      breatheMinOpacity += (targetBreatheMinOpacity - breatheMinOpacity) * breatheSmoothing;
      breatheMaxOpacity += (targetBreatheMaxOpacity - breatheMaxOpacity) * breatheSmoothing;
      breatheCycleDuration +=
        (targetBreatheCycleDuration - breatheCycleDuration) * breatheSmoothing;
    }

    const safeCycleDuration = Math.max(0.5, breatheCycleDuration);
    breathePhase += deltaTime / safeCycleDuration;
    if (breathePhase >= 1) {
      // 完成一个呼吸周期，重新随机亮度范围和周期时长（平滑过渡）
      breathePhase %= 1;
      targetBreatheMinOpacity = getRandomBreatheMin();
      targetBreatheMaxOpacity = getRandomBreatheMax();
      targetBreatheCycleDuration = getRandomBreatheDuration();
    }

    // 正弦波呼吸效果 × 淡入系数
    syncBreatheOpacity();

    if (isAutoGlow) {
      // 自动游走模式
      if (isResting) {
        // 休息中，检查是否休息完毕
        if (now - restStartTime >= currentRestDuration) {
          isResting = false;
          // 选择新的随机目标
          const newTarget = getRandomWanderTarget();
          targetGlowX = newTarget.x;
          targetGlowY = newTarget.y;
          // 休息结束，速度从零开始（会有加速过程）
          currentSpeedX = 0;
          currentSpeedY = 0;
        }
        // 休息期间不移动
      } else {
        // 向目标移动（使用游走加速度）
        const result = moveTowardsTarget(currentGlowX, currentGlowY, targetGlowX, targetGlowY, deltaTime, WANDER_ACCELERATION);

        if (result.reached) {
          // 到达目标，开始休息
          isResting = true;
          restStartTime = now;
          currentRestDuration = Math.random() * 8000; // 重新随机下一次休息时间 0-8 秒
        }

        updateGlowPosition(result.x * w, result.y * h);
      }
    } else {
      // 鼠标跟随模式：定期采样鼠标位置（每3秒更新一次目标）
      if (now - lastMouseSampleTime >= MOUSE_SAMPLE_INTERVAL) {
        setMouseTarget(latestMouseX, latestMouseY);
        lastMouseSampleTime = now;
      }

      // 向目标移动（使用更慢的加速度，更柔和）
      const result = moveTowardsTarget(currentGlowX, currentGlowY, targetGlowX, targetGlowY, deltaTime, MOUSE_ACCELERATION);
      updateGlowPosition(result.x * w, result.y * h);
    }

    glowAnimationFrame = requestAnimationFrame(animateGlow);
  };

  const enableAutoGlow = () => {
    if (isAutoGlow) return;
    isAutoGlow = true;
    // 立即选择一个新的随机目标
    const newTarget = getRandomWanderTarget();
    targetGlowX = newTarget.x;
    targetGlowY = newTarget.y;
  };

  const setMouseTarget = (x, y) => {
    isAutoGlow = false;
    targetGlowX = x / window.innerWidth;
    targetGlowY = y / window.innerHeight;
  };

  document.addEventListener('mousemove', (e) => {
    // 只有页面可见时才响应鼠标移动
    if (document.hidden) return;

    // 记录最新鼠标位置（不立即更新目标）
    latestMouseX = e.clientX;
    latestMouseY = e.clientY;

    // 如果是第一次移动鼠标（从自动游走切换过来），立即采样一次
    if (isAutoGlow) {
      isAutoGlow = false;
      lastMouseSampleTime = Date.now();
      setMouseTarget(latestMouseX, latestMouseY);
    }

    // 重置空闲计时器
    clearTimeout(mouseIdleTimer);
    mouseIdleTimer = setTimeout(() => {
      enableAutoGlow();
    }, 6000);
  });

  // 页面可见性变化监听：切换标签页或最小化时停止捕捉鼠标
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 页面不可见：停止捕捉鼠标，进入自动游走模式
      clearTimeout(mouseIdleTimer);
      enableAutoGlow();

      // 10秒后停止渲染（节省性能）
      visibilityTimer = setTimeout(() => {
        isRenderingStopped = true;
        cancelAnimationFrame(glowAnimationFrame);

        // 淡出所有光晕效果
        document.body.style.setProperty('--breathe-opacity', '0');
        document.body.style.setProperty('--reflect-top', '0');
        document.body.style.setProperty('--reflect-bottom', '0');
        document.body.style.setProperty('--reflect-left', '0');
        document.body.style.setProperty('--reflect-right', '0');
      }, 10000);
    } else {
      // 页面可见：取消计时器，恢复渲染
      clearTimeout(visibilityTimer);

      if (isRenderingStopped) {
        // 重新启动渲染，从淡入开始
        isRenderingStopped = false;
        fadeInPhase = 0; // 重置淡入进度
        lastFrameTime = Date.now();
        animateGlow();
      }
    }
  });

  initializeGlowState();
  applyGlowColor();
  syncBreatheOpacity();
  animateGlow();

  /**
   * Base64url 编码（URL 安全 base64）
   * @param {string} str
   * @returns {string}
   */
  function base64urlEncode(str) {
    const base64 = btoa(str);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const fileNameEl = $('fileName');
  const downloadBtn = $('downloadBtn');
  const retryBtn = $('retryBtn');
  const advancedToggleBtn = $('advancedToggle');
  const advancedPanel = $('advancedPanel');
  const advancedBackdrop = $('advancedBackdrop');
  const advancedCloseBtn = $('advancedCloseBtn');
  const clearCacheBtn = $('clearCacheBtn');
  const clearEnvBtn = $('clearEnvBtn');
  const retryFailedSegmentsBtn = $('retryFailedSegmentsBtn');
  const cancelBtn = $('cancelBtn');
  const connectionLimitInput = $('connectionLimitInput');
  const retryLimitInput = $('retryLimitInput');
  const parallelLimitInput = $('parallelLimitInput');
  const segmentSizeInput = $('segmentSizeInput');
  const ttfbTimeoutInput = $('ttfbTimeoutInput');
  const downloadBar = $('downloadBar');
  const decryptBar = $('decryptBar');
  const downloadText = $('downloadText');
  const decryptText = $('decryptText');
  const speedText = $('speedText');
  const keygenPasswordInput = $('keygenPassword');
  const keygenSaltInput = $('keygenSalt');
  const keygenRunBtn = $('keygenRun');
  const keygenCopyBtn = $('keygenCopy');
  const keygenStatusEl = $('keygenStatus');
  const keygenOutputEl = $('keygenOutput');
  const keygenLoadingEl = $('keygenLoading');
  const logEl = $('log');
  const turnstileContainer = $('turnstileContainer');
  const turnstileMessage = $('turnstileMessage');
  const clientDecryptSection = $('clientDecryptSection');
  const clientDecryptFileInput = $('clientDecryptFileInput');
  const clientDecryptSelectBtn = $('clientDecryptSelect');
  const clientDecryptStartBtn = $('clientDecryptStart');
  const clientDecryptCancelBtn = $('clientDecryptCancel');
  const clientDecryptFileNameEl = $('clientDecryptFileName');
  const clientDecryptFileSizeEl = $('clientDecryptFileSize');
  const clientDecryptStatusHint = $('clientDecryptStatusHint');
  const autoRedirectEnabled = window.__AUTO_REDIRECT__ === true;
  const webDownloaderProps = window.__WEB_DOWNLOADER_PROPS__ || {};
  const clientDecryptSupported = webDownloaderProps?.clientDecrypt === true;

  const log = (message) => {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.textContent = '[' + time + '] ' + message;
    logEl.appendChild(entry);
    logEl.scrollTop = logEl.scrollHeight;
  };

  let autoRedirectWebNoticeShown = false;
  const notifyAutoRedirectForWeb = () => {
    if (!autoRedirectEnabled || autoRedirectWebNoticeShown) {
      return;
    }
    autoRedirectWebNoticeShown = true;
    // No need to log, status already shows "准备就绪"
  };

  const setStatus = (text) => {
    statusEl.textContent = text;
    log(text);
  };

  // clientDecryptSection 的显示逻辑移至获取 /info 成功后
  // 不在页面加载时就显示，避免在验证前误导用户

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
    return value.toFixed(digits) + ' ' + units[unitIndex];
  };

  const clamp = (value, min, max, fallback) => {
    if (!Number.isFinite(value)) return fallback;
    if (value < min) return min;
    if (value > max) return max;
    return value;
  };

  const base64ToUint8 = (value) => {
    if (!value) return new Uint8Array(0);
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  };

  const bytesToHex = (bytes) =>
    Array.from(bytes || [])
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

  const BYTES_PER_MB = 1024 * 1024;
  const MIN_SEGMENT_SIZE_MB = 2;
  const MAX_SEGMENT_SIZE_MB = 48;
  const DEFAULT_SEGMENT_SIZE_MB = 32;
  const MIN_PARALLEL_THREADS = 1;
  const MAX_PARALLEL_THREADS = 32;
  const DEFAULT_PARALLEL_THREADS = 6;

  const CRYPT_HEADER_MAGIC = new Uint8Array([82, 67, 76, 79, 78, 69, 0, 0]);
  const CRYPT_NONCE_SIZE = 24;

  const cloneUint8 = (input) => {
    if (!input) return new Uint8Array(0);
    return input.slice ? input.slice() : new Uint8Array(input);
  };

  const incrementNonce = (baseNonce, increment) => {
    const output = cloneUint8(baseNonce);
    let carry = BigInt(increment);
    let index = 0;
    while (carry > 0n && index < output.length) {
      const sum = BigInt(output[index]) + (carry & 0xffn);
      output[index] = Number(sum & 0xffn);
      carry = (carry >> 8n) + (sum >> 8n);
      index += 1;
    }
    return output;
  };

  const extractCryptNonce = (headerBuffer) => {
    if (!headerBuffer || headerBuffer.length < CRYPT_HEADER_MAGIC.length + CRYPT_NONCE_SIZE) {
      throw new Error('crypt header 长度不足');
    }
    for (let i = 0; i < CRYPT_HEADER_MAGIC.length; i += 1) {
      if (headerBuffer[i] !== CRYPT_HEADER_MAGIC[i]) {
        throw new Error('crypt header 魔数不匹配');
      }
    }
    const nonceStart = CRYPT_HEADER_MAGIC.length;
    const nonceEnd = nonceStart + CRYPT_NONCE_SIZE;
    return cloneUint8(headerBuffer.subarray(nonceStart, nonceEnd));
  };

  const decryptBlock = (cipherBlock, dataKey, baseNonce, blockIndex) => {
    const nonce = incrementNonce(baseNonce, blockIndex);
    const opened = window.nacl?.secretbox?.open(cipherBlock, nonce, dataKey);
    if (!opened) return null;
    return new Uint8Array(opened);
  };

  // 解密 Worker 脚本（通过 Blob URL 注入）
  const decryptWorkerScript = [
    '/* eslint-disable no-restricted-globals */',
    '(() => {',
    "  'use strict';",
    '  let state = {',
    '    dataKey: null,',
    '    baseNonce: null,',
    '    blockHeaderSize: 0,',
    '    blockDataSize: 0,',
    "    encryptionMode: 'plain',",
    '  };',
    '',
    '  const cloneUint8 = (input) => {',
    '    if (!input) return new Uint8Array(0);',
    '    return input.slice ? input.slice() : new Uint8Array(input);',
    '  };',
    '',
    '  const incrementNonce = (baseNonce, increment) => {',
    '    const output = cloneUint8(baseNonce);',
    '    let carry = BigInt(increment);',
    '    let index = 0;',
    '    while (carry > 0n && index < output.length) {',
    '      const sum = BigInt(output[index]) + (carry & 0xffn);',
    '      output[index] = Number(sum & 0xffn);',
    '      carry = (carry >> 8n) + (sum >> 8n);',
    '      index += 1;',
    '    }',
    '    return output;',
    '  };',
    '',
    '  const decryptBlock = (cipherBlock, dataKey, baseNonce, blockIndex) => {',
    '    const nonce = incrementNonce(baseNonce, blockIndex);',
    '    const opened = self.nacl?.secretbox?.open(cipherBlock, nonce, dataKey);',
    '    if (!opened) return null;',
    '    return new Uint8Array(opened);',
    '  };',
    '',
    '  const decryptSegmentPayload = (payload) => {',
    '    const {',
    '      buffer,',
    '      length,',
    '      mapping,',
    '    } = payload || {};',
    '',
    '    if (!buffer || !Number.isFinite(length) || length <= 0) {',
    "      throw new Error('缺少分段数据');",
    '    }',
    '',
    '    const cipher = new Uint8Array(buffer);',
    "    if (state.encryptionMode !== 'crypt') {",
    '      if (cipher.length < length) {',
    "        throw new Error('密文长度不足');",
    '      }',
    '      return cipher.subarray(0, length);',
    '    }',
    '    if (!state.dataKey || !state.baseNonce) {',
    "      throw new Error('缺少解密密钥');",
    '    }',
    '    if (!mapping || !Number.isFinite(state.blockHeaderSize) || !Number.isFinite(state.blockDataSize)) {',
    "      throw new Error('缺少分段映射或块尺寸');",
    '    }',
    '',
    '    const output = new Uint8Array(length);',
    '    let produced = 0;',
    '    let offset = 0;',
    '    let discard = mapping.discard || 0;',
    '    let blockIndex = mapping.blocks || 0;',
    '',
    '    while (offset < cipher.length && produced < length) {',
    '      if (offset + state.blockHeaderSize > cipher.length) {',
    '        break;',
    '      }',
    '      let end = offset + state.blockHeaderSize + state.blockDataSize;',
    '      if (end > cipher.length) {',
    '        end = cipher.length;',
    '      }',
    '      const cipherBlock = cipher.subarray(offset, end);',
    '      offset = end;',
    '      const plainBlock = decryptBlock(cipherBlock, state.dataKey, state.baseNonce, blockIndex);',
    '      if (!plainBlock) {',
    "        throw new Error('解密失败，请重试');",
    '      }',
    '      let chunk = plainBlock;',
    '      if (blockIndex === mapping.blocks && discard > 0) {',
    '        if (chunk.length <= discard) {',
    '          discard -= chunk.length;',
    '          blockIndex += 1;',
    '          continue;',
    '        }',
    '        chunk = chunk.subarray(discard);',
    '        discard = 0;',
    '      }',
    '      const remaining = length - produced;',
    '      if (chunk.length > remaining) {',
    '        output.set(chunk.subarray(0, remaining), produced);',
    '        produced += remaining;',
    '        break;',
    '      }',
    '      output.set(chunk, produced);',
    '      produced += chunk.length;',
    '      blockIndex += 1;',
    '    }',
    '',
    '    if (produced !== length) {',
    "      throw new Error('解密输出长度不匹配');",
    '    }',
    '    return output;',
    '  };',
    '',
    '  const sendError = (jobId, index, message) => {',
    '    self.postMessage({',
    "      type: 'segment-error',",
    '      jobId,',
    '      index,',
    "      message: message || 'decrypt failed',",
    '    });',
    '  };',
    '',
    '  const handleDecrypt = (data) => {',
    '    const { jobId, index, buffer, length, mapping } = data || {};',
    '    if (!jobId) return;',
    '    try {',
    '      const plain = decryptSegmentPayload({ buffer, length, mapping });',
    '      self.postMessage(',
    '        {',
    "          type: 'segment-done',",
    '          jobId,',
    '          index,',
    '          buffer: plain.buffer,',
    '        },',
    '        [plain.buffer],',
    '      );',
    '    } catch (error) {',
    '      const message = error && error.message ? error.message : "decrypt error";',
    '      sendError(jobId, index, message);',
    '    }',
    '  };',
    '',
    '  self.onmessage = (event) => {',
    '    const data = event && event.data;',
    '    if (!data || typeof data !== "object") return;',
    "    if (data.type === 'init') {",
    '      const mode = typeof data.encryptionMode === "string" ? data.encryptionMode.toLowerCase() : "";',
    "      if (mode !== 'crypt' && mode !== 'plain') {",
    "        throw new Error('未知加密模式: ' + mode);",
    '      }',
    '      state = {',
    '        dataKey: data.dataKey ? new Uint8Array(data.dataKey) : null,',
    '        baseNonce: data.baseNonce ? new Uint8Array(data.baseNonce) : null,',
    '        blockHeaderSize: Number(data.blockHeaderSize) || 0,',
    '        blockDataSize: Number(data.blockDataSize) || 0,',
    '        encryptionMode: mode,',
    '      };',
    '      return;',
    '    }',
    "    if (data.type === 'decrypt-segment') {",
    '      handleDecrypt(data);',
    '    }',
    '  };',
    '})();',
  ].join('\n');

  const getDecryptWorkerUrl = (() => {
    let url = null;
    return () => {
      if (url) return url;
      const prefix = "importScripts('https://cdn.jsdelivr.net/npm/tweetnacl@1.0.3/nacl-fast.min.js');\n";
      const blob = new Blob([prefix + decryptWorkerScript], { type: 'application/javascript' });
      url = URL.createObjectURL(blob);
      return url;
    };
  })();

  const createDecryptWorker = (commonParams) => {
    const worker = new Worker(getDecryptWorkerUrl());
    let jobId = 1;
    const pending = new Map();

    worker.addEventListener('message', (event) => {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return;
      if (data.type === 'segment-done') {
        const record = pending.get(data.jobId);
        if (record) {
          pending.delete(data.jobId);
          record.resolve({ index: data.index, plain: new Uint8Array(data.buffer || []) });
        }
      } else if (data.type === 'segment-error') {
        const record = pending.get(data.jobId);
        if (record) {
          pending.delete(data.jobId);
          const message = data.message || '解密失败';
          record.reject(new Error(message));
        }
      }
    });

    worker.postMessage({
      type: 'init',
      dataKey: commonParams?.dataKey,
      baseNonce: commonParams?.baseNonce,
      blockHeaderSize: commonParams?.blockHeaderSize,
      blockDataSize: commonParams?.blockDataSize,
      encryptionMode: commonParams?.encryptionMode,
    });

    const runJob = (index, payload) =>
      new Promise((resolve, reject) => {
        const jobKey = jobId;
        jobId += 1;
        pending.set(jobKey, { resolve, reject });
        const transferable = [];
        if (payload && payload.encrypted && payload.encrypted.buffer) {
          transferable.push(payload.encrypted.buffer);
        }
        worker.postMessage(
          {
            type: 'decrypt-segment',
            jobId: jobKey,
            index,
            length: payload.length,
            mapping: payload.mapping,
            buffer: payload.encrypted ? payload.encrypted.buffer : null,
          },
          transferable,
        );
      });

    const terminate = () => {
      try {
        worker.terminate();
      } catch (error) {
        // ignore
      }
    };

    return { runJob, terminate };
  };

  const runSegmentDecryptionTask = async ({
    mode = 'webDownloader',
    segments = [],
    parallelism = 1,
    commonParams = {},
    getPayload,
    writeOrderedChunk,
    isCancelled,
  } = {}) => {
    if (!Array.isArray(segments) || segments.length === 0) {
      return;
    }
    const workerCount = Math.max(1, Math.min(parallelism, segments.length));
    const workers = new Array(workerCount).fill(null).map(() => createDecryptWorker(commonParams));
    console.info('[landing] 启动 Web Worker 解密池，数量:', workerCount);
    let nextToAssign = 0;
    let nextToWrite = 0;
    const pendingResults = new Map();
    let flushError = null;
    let flushChain = Promise.resolve();

    const scheduleFlush = () => {
      flushChain = flushChain
        .then(async () => {
          while (pendingResults.has(nextToWrite)) {
            const chunk = pendingResults.get(nextToWrite);
            pendingResults.delete(nextToWrite);
            if (typeof writeOrderedChunk === 'function') {
              await writeOrderedChunk(nextToWrite, chunk);
            }
            nextToWrite += 1;
          }
        })
        .catch((error) => {
          flushError = error instanceof Error ? error : new Error(String(error));
          throw flushError;
        });
    };

    const shouldCancel = () => {
      if (typeof isCancelled === 'function') {
        return isCancelled();
      }
      return false;
    };

    const workerLoop = async (worker) => {
      while (true) {
        if (flushError) {
          throw flushError;
        }
        if (shouldCancel()) {
          throw new Error('cancelled');
        }
        const currentIndex = nextToAssign;
        if (currentIndex >= segments.length) {
          break;
        }
        nextToAssign += 1;
        const payload = typeof getPayload === 'function' ? await getPayload(currentIndex) : null;
        if (!payload || !payload.encrypted) {
          throw new Error('缺少分段数据');
        }
        const { plain } = await worker.runJob(currentIndex, payload);
        pendingResults.set(currentIndex, plain);
        scheduleFlush();
      }
    };

    try {
      await Promise.all(workers.map((worker) => workerLoop(worker)));
      await flushChain;
      if (flushError) {
        throw flushError;
      }
      if (nextToWrite !== segments.length) {
        throw new Error('仍有分段未完成解密');
      }
    } finally {
      workers.forEach((worker) => worker.terminate());
    }
  };

  const calculateUnderlying = (offset, limit, meta) => {
    const fallbackLimit = limit >= 0 ? limit : -1;
    if (
      !meta ||
      meta.encryption === 'plain' ||
      !Number.isFinite(meta.blockDataSize) ||
      meta.blockDataSize <= 0 ||
      !Number.isFinite(meta.blockHeaderSize) ||
      meta.blockHeaderSize <= 0 ||
      !Number.isFinite(meta.fileHeaderSize) ||
      meta.fileHeaderSize <= 0
    ) {
      return {
        underlyingOffset: offset,
        underlyingLimit: fallbackLimit,
        discard: 0,
        blocks: 0,
      };
    }

    const blockData = meta.blockDataSize;
    const blockHeader = meta.blockHeaderSize;
    const headerSize = meta.fileHeaderSize;
    const blocks = Math.floor(offset / blockData);
    const discard = offset % blockData;
    let underlyingOffset = headerSize + blocks * (blockHeader + blockData);
    let underlyingLimit = -1;
    if (limit >= 0) {
      let bytesToRead = limit - (blockData - discard);
      let blocksToRead = 1;
      if (bytesToRead > 0) {
        const extraBlocks = Math.floor(bytesToRead / blockData);
        const remainder = bytesToRead % blockData;
        blocksToRead += extraBlocks;
        if (remainder !== 0) {
          blocksToRead += 1;
        }
      }
      underlyingLimit = blocksToRead * (blockHeader + blockData);
    }

    return { underlyingOffset, underlyingLimit, discard, blocks };
  };

  const decodeDownloadUrl = (download) => {
    if (download.urlBase64) {
      try {
        return atob(download.urlBase64);
      } catch (error) {
        console.warn('download.urlBase64 解码失败，回退到 url', error);
      }
    }
    return download.url;
  };

  const normalizeDownloadInfo = (info) => {
    if (!info || !info.download) {
      throw new Error('缺少下载信息');
    }
    const remote = {
      url: decodeDownloadUrl(info.download),
      method: info.download.remote?.method || 'GET',
      headers: info.download.remote?.headers || {},
    };
    const remoteLength = Number(info.download.remote?.length);
    const metaSize = Number(info.meta?.size);
    let totalSize = 0;
    if (Number.isFinite(remoteLength) && remoteLength > 0) {
      totalSize = remoteLength;
    } else if (Number.isFinite(metaSize) && metaSize > 0) {
      totalSize = metaSize;
    }
    const downloadMeta = info.download.meta || {};
    const encryptionMode = downloadMeta.encryption === 'crypt' ? 'crypt' : 'plain';
    const blockHeaderSize = Number(downloadMeta.blockHeaderSize) || 0;
    const blockDataSize = Number(downloadMeta.blockDataSize) || 0;
    const fileHeaderSize = Number(downloadMeta.fileHeaderSize) || 0;
    const dataKey = downloadMeta.dataKey ? base64ToUint8(downloadMeta.dataKey) : null;
    const meta = info.meta && typeof info.meta === 'object' ? { ...info.meta } : {};
    meta.size = totalSize;
    const pathValue = typeof meta.path === 'string' ? meta.path : '';
    const fileNameCandidate = typeof meta.fileName === 'string' && meta.fileName.trim().length > 0
      ? meta.fileName.trim()
      : '';
    let fallbackName = '';
    if (!fileNameCandidate && pathValue) {
      const parts = pathValue.split('/').filter(Boolean);
      fallbackName = parts.length > 0 ? parts[parts.length - 1] : '';
    }
    const fileName = fileNameCandidate || fallbackName || 'download.bin';
    return {
      remote,
      totalSize,
      meta,
      encryptionMode,
      blockHeaderSize,
      blockDataSize,
      fileHeaderSize,
      dataKey,
      fileName,
    };
  };

  if (connectionLimitInput && !connectionLimitInput.value) {
    const defaultConnections = clamp(Number(webDownloaderProps?.config?.maxConnections) || 6, 1, 16, 6);
    connectionLimitInput.value = String(defaultConnections);
  }
  if (retryLimitInput && !retryLimitInput.value) {
    retryLimitInput.value = '30';
  }
  if (parallelLimitInput && !parallelLimitInput.value) {
    parallelLimitInput.value = '6';
  }
  if (segmentSizeInput && !segmentSizeInput.value) {
    segmentSizeInput.value = '12';
  }
  if (ttfbTimeoutInput && !ttfbTimeoutInput.value) {
    ttfbTimeoutInput.value = '20';
  }

  /**
   * Set button text with optional spinner
   * @param {HTMLElement} button - The button element
   * @param {string} text - Button text
   * @param {boolean} loading - Whether to show spinner
   */
  const setButtonText = (button, text, loading = false) => {
    if (!button) return;

    // Clear existing content
    button.innerHTML = '';

    if (loading) {
      // Create spinner element
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      button.appendChild(spinner);
    }

    // Add text
    const textNode = document.createTextNode(text);
    button.appendChild(textNode);
  };

  const copyToClipboard = async (text, button) => {
    if (!text || !button) return;
    try {
      await navigator.clipboard.writeText(text);
      const originalText = button.textContent;
      button.textContent = '已复制✓';
      setTimeout(() => {
        button.textContent = originalText;
      }, 1500);
    } catch (error) {
      console.error('复制失败', error);
      const originalText = button.textContent;
      button.textContent = '复制失败';
      setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    }
  };

  let scryptModulePromise = null;
  const ensureScryptModule = () => {
    if (!scryptModulePromise) {
      scryptModulePromise = import('https://cdn.jsdelivr.net/npm/scrypt-js@3.0.1/+esm');
    }
    return scryptModulePromise;
  };
  const textEncoder = new TextEncoder();
  const defaultKeygenSalt = new Uint8Array([
    0xa8, 0x0d, 0xf4, 0x3a, 0x8f, 0xbd, 0x03, 0x08,
    0xa7, 0xca, 0xb8, 0x3e, 0x58, 0x1f, 0x86, 0xb1,
  ]);

    const pendingSegmentWaiters = [];

  const state = {
    downloadURL: '',
    infoReady: false,
    fetchingInfo: false,
    infoError: false,
    downloadBtnMode: 'download', // 'download' or 'copy'
    awaitingRetryUnlock: false,
      mode: 'legacy',
    webTask: null,
    security: {
      underAttack: false,
      siteKey: '',
      turnstileAction: 'download',
      altchaChallenge: null,
      turnstileBinding: null,
      scriptLoaded: false,
      scriptLoading: null,
      widgetId: null,
    },
      verification: {
        needAltcha: false,
        needTurnstile: false,
        altchaReady: false,
        turnstileReady: false,
        altchaSolution: null,
        turnstileToken: null,
        altchaIssuedAt: 0,
        turnstileIssuedAt: 0,
        tokenResolvers: [],
      },
      clientDecrypt: {
        enabled: clientDecryptSupported,
        ready: false,
        running: false,
        completed: false,
        failed: false,
        downloadInitiated: false,
        isCrypt: false,
        file: null,
        fileName: '',
        fileSize: 0,
        decryptParallelism: DEFAULT_PARALLEL_THREADS,
        decryptParallelRaw: String(DEFAULT_PARALLEL_THREADS),
        segmentSizeMb: DEFAULT_SEGMENT_SIZE_MB,
        segmentSizeRaw: String(DEFAULT_SEGMENT_SIZE_MB),
      },
  };

  window.__landingState = state;

  const syncBodyModeClasses = () => {
    if (!document || !document.body) return;
    document.body.classList.toggle('web-downloader-active', state.mode === 'web');
    document.body.classList.toggle('client-decrypt-active', state.mode === 'client-decrypt');
  };

  if (clientDecryptSupported && !webDownloaderProps?.enabled) {
    state.mode = 'client-decrypt';
  }
  syncBodyModeClasses();

  const webDownloader = (() => {
    // use shared segment size constants
    const MIN_CONNECTIONS = 1;
    const MAX_CONNECTIONS = 32;
    const DEFAULT_CONNECTIONS = clamp(
      Number(webDownloaderProps?.config?.maxConnections) || 16,
      MIN_CONNECTIONS,
      MAX_CONNECTIONS,
      16
    );
    const DEFAULT_RETRY_LIMIT = 5;
    const SPEED_WINDOW = 1500;

    const sleep = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
      });

    const REQUEST_INTERVAL_MS = 300;
    const DEFAULT_SEGMENT_RETRY_LIMIT = 30;
    const INFINITE_RETRY_TOKEN = 'inf';
    const RETRY_DELAY_MS = 20000;
    const HTTP429_BASE_DELAY_MS = 1000;
    const HTTP429_SILENT_RETRY_LIMIT = 9;
    const HTTP429_MAX_DELAY_MS = 10000;
    const MIN_TTFB_TIMEOUT_SECONDS = 5;
    const MAX_TTFB_TIMEOUT_SECONDS = 120;
    const DEFAULT_TTFB_TIMEOUT_SECONDS = 20;

    const clampSegmentSizeMb = (value) =>
      clamp(Number(value), MIN_SEGMENT_SIZE_MB, MAX_SEGMENT_SIZE_MB, DEFAULT_SEGMENT_SIZE_MB);
    const clampTtfbTimeoutSeconds = (value) =>
      clamp(Number(value), MIN_TTFB_TIMEOUT_SECONDS, MAX_TTFB_TIMEOUT_SECONDS, DEFAULT_TTFB_TIMEOUT_SECONDS);
    const toSegmentSizeBytes = (maybeMb) => Math.round(clampSegmentSizeMb(maybeMb) * BYTES_PER_MB);
    const toTtfbTimeoutMs = (maybeSeconds) =>
      Math.round(clampTtfbTimeoutSeconds(maybeSeconds) * 1000);

    const STORAGE_DB_NAME = 'landing-webdownloader-v2';
    const STORAGE_DB_VERSION = 3;
    const STORAGE_TABLE_SETTINGS = 'settings';
    const STORAGE_TABLE_INFO = 'infoCache';
    const STORAGE_TABLE_HANDLES = 'writerHandles';
    const STORAGE_TABLE_SEGMENTS = 'segments';
    const STORAGE_SESSION_FLAG = 'landing-webdownloader-session';
    const STORAGE_PREFIX = 'landing-web::';
    const STORAGE_VERSION = 1;
    const GLOBAL_DATA_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
    const INFO_CACHE_TTL_MS = GLOBAL_DATA_TTL_MS;

    const openStorageDatabase = (() => {
      let promise = null;
      return () => {
        if (promise) return promise;
        promise = (async () => {
          if (typeof window === 'undefined' || !window.indexedDB || !window.Dexie) {
            return null;
          }
          const DexieClass = window.Dexie;
          const db = new DexieClass(STORAGE_DB_NAME);
          db.version(1).stores({
            [STORAGE_TABLE_SETTINGS]: '&key',
            [STORAGE_TABLE_INFO]: '&key,timestamp',
            [STORAGE_TABLE_HANDLES]: '&key',
          });
          db
            .version(2)
            .stores({
              [STORAGE_TABLE_SETTINGS]: '&key',
              [STORAGE_TABLE_INFO]: '&key,timestamp',
              [STORAGE_TABLE_HANDLES]: '&key',
              [STORAGE_TABLE_SEGMENTS]: '[key+index],key',
            })
            .upgrade(async (transaction) => {
              try {
                const table = transaction.table(STORAGE_TABLE_SEGMENTS);
                if (table) {
                  await table.clear();
                }
              } catch (upgradeError) {
                console.warn('升级 Dexie 存储结构失败', upgradeError);
              }
            });
          db
            .version(STORAGE_DB_VERSION)
            .stores({
              [STORAGE_TABLE_SETTINGS]: '&key',
              [STORAGE_TABLE_INFO]: '&key,timestamp',
              [STORAGE_TABLE_HANDLES]: '&key,timestamp',
              [STORAGE_TABLE_SEGMENTS]: '[key+index],key,timestamp',
            })
            .upgrade(async (transaction) => {
              try {
                const handlesTable = transaction.table(STORAGE_TABLE_HANDLES);
                if (handlesTable) {
                  const now = Date.now();
                  await handlesTable.toCollection().modify((record) => {
                    if (!Number.isFinite(record.timestamp) || record.timestamp <= 0) {
                      record.timestamp = now;
                    }
                  });
                }
              } catch (upgradeError) {
                console.warn('升级 Dexie 存储结构失败', upgradeError);
              }
            });
          return db;
        })().catch((error) => {
          console.warn('初始化 webDownloader Dexie 存储失败', error);
          return null;
        });
        return promise;
      };
    })();

    const ensureSessionIsolation = (() => {
      let promise = null;
      return () => {
        if (promise) return promise;
        promise = (async () => {
          if (typeof window === 'undefined') return;
          let hasActiveSession = false;
          if (window.sessionStorage) {
            try {
              hasActiveSession = window.sessionStorage.getItem(STORAGE_SESSION_FLAG) === '1';
            } catch (error) {
              console.warn('读取 sessionStorage 状态失败', error);
            }
          }
          if (!hasActiveSession) {
            const db = await openStorageDatabase();
            if (db) {
              const tables = [
                STORAGE_TABLE_SETTINGS,
                STORAGE_TABLE_INFO,
                STORAGE_TABLE_HANDLES,
                STORAGE_TABLE_SEGMENTS,
              ];
              await Promise.all(
                tables.map(async (tableName) => {
                  try {
                    await db.table(tableName).clear();
                  } catch (error) {
                    console.warn('清理 Dexie 表 ' + tableName + ' 失败', error);
                  }
                }),
              );
            }
          }
          if (window.sessionStorage) {
            try {
              window.sessionStorage.setItem(STORAGE_SESSION_FLAG, '1');
            } catch (error) {
              console.warn('写入 sessionStorage 状态失败', error);
            }
          }
        })();
        return promise;
      };
    })();

    const useStorageTable = async (tableName, executor, { defaultValue = null } = {}) => {
      await ensureSessionIsolation();
      const db = await openStorageDatabase();
      if (!db) return defaultValue;
      try {
        return await executor(db.table(tableName));
      } catch (error) {
        console.warn('访问 webDownloader Dexie 表 ' + tableName + ' 时出错', error);
        return defaultValue;
      }
    };

    const cleanupExpiredData = async () => {
      const expiredBefore = Date.now() - GLOBAL_DATA_TTL_MS;
      let totalCleaned = 0;
      const tables = [STORAGE_TABLE_INFO, STORAGE_TABLE_SEGMENTS, STORAGE_TABLE_HANDLES];
      for (const tableName of tables) {
        const cleaned = await useStorageTable(
          tableName,
          (table) => table.where('timestamp').below(expiredBefore).delete(),
          { defaultValue: 0 },
        );
        totalCleaned += Number(cleaned) || 0;
      }
      log('已清理 ' + totalCleaned + ' 条过期数据（24小时前）');
      return totalCleaned;
    };

    const buildCacheKey = (path, sign) => {
      if (!path) return '';
      const pathPart = encodeURIComponent(path);
      const signPart = encodeURIComponent(sign || '');
      return STORAGE_PREFIX + pathPart + '::' + signPart;
    };

    const saveInfoToCache = async (key, data) => {
      if (!key || !data) return;
      await useStorageTable(
        STORAGE_TABLE_INFO,
        (table) =>
          table.put({
            key,
            version: STORAGE_VERSION,
            timestamp: Date.now(),
            data,
          }),
        { defaultValue: undefined },
      );
    };

    const loadCachedInfo = async (key) => {
      if (!key) return null;
      const now = Date.now();
      return useStorageTable(
        STORAGE_TABLE_INFO,
        async (table) => {
          const record = await table.get(key);
          if (!record) return null;
          const version = Number(record.version) || 0;
          const timestamp = Number(record.timestamp) || 0;
          const hasData = record.data && typeof record.data === 'object';
          if (version !== STORAGE_VERSION || !hasData) {
            await table.delete(key);
            return null;
          }
          if (!Number.isFinite(timestamp) || timestamp <= 0 || now - timestamp > INFO_CACHE_TTL_MS) {
            await table.delete(key);
            return null;
          }
          return record.data;
        },
        { defaultValue: null },
      );
    };

    const removeInfoCache = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_INFO,
        (table) => table.delete(key),
        { defaultValue: undefined },
      );
    };

    const clonePersistedSegment = (value) => {
      if (!value) return null;
      if (value instanceof Uint8Array) {
        return new Uint8Array(value);
      }
      if (value instanceof ArrayBuffer) {
        return new Uint8Array(value.slice(0));
      }
      if (ArrayBuffer.isView(value) && value.buffer) {
        const { buffer, byteOffset, byteLength } = value;
        return new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength));
      }
      if (value && typeof value === 'object' && value.data) {
        return clonePersistedSegment(value.data);
      }
      return null;
    };

    const buildSegmentSignature = (meta) => {
      if (!meta) return '';
      const size = Number(meta.size) || 0;
      const blockData = Number(meta.blockDataSize) || 0;
      const blockHeader = Number(meta.blockHeaderSize) || 0;
      const fileHeader = Number(meta.fileHeaderSize) || 0;
      const encryption = meta.encryption === 'plain' ? 'plain' : 'crypt';
      const segmentSizeBytes =
        Number(meta.segmentSizeBytes) || DEFAULT_SEGMENT_SIZE_MB * BYTES_PER_MB;
      return [size, blockData, blockHeader, fileHeader, encryption, segmentSizeBytes].join(':');
    };

    const buildCurrentMetaForSignature = () => ({
      size: Number(state.totalSize) || 0,
      blockDataSize: Number(state.blockDataSize) || 0,
      blockHeaderSize: Number(state.blockHeaderSize) || 0,
      fileHeaderSize: Number(state.fileHeaderSize) || 0,
      encryption: state.encryptionMode === 'crypt' ? 'crypt' : 'plain',
      segmentSizeBytes: toSegmentSizeBytes(state.segmentSizeMb),
    });

    const areUint8ArraysEqual = (a, b) => {
      if (!a && !b) return true;
      if (!a || !b) return false;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
          return false;
        }
      }
      return true;
    };

    const persistSegmentData = async (key, index, data, meta) => {
      if (!key || !Number.isInteger(index) || !data || data.length === 0) return;
      const payload = {
        key,
        index,
        signature: buildSegmentSignature(meta),
        length: data.length,
        data: data.slice(),
        timestamp: Date.now(),
      };
      await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.put(payload),
        { defaultValue: undefined },
      );
    };

    const loadPersistedSegmentRecords = async (key) => {
      if (!key) return [];
      const records = await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.where('key').equals(key).toArray(),
        { defaultValue: [] },
      );
      return Array.isArray(records) ? records : [];
    };

    const clearSegmentsForKey = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_SEGMENTS,
        (table) => table.where('key').equals(key).delete(),
        { defaultValue: undefined },
      );
    };

    const saveWriterHandle = async (key, handle) => {
      if (!key || !handle) return;
      await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.put({ key, handle, timestamp: Date.now() }),
        { defaultValue: undefined },
      );
    };

    const loadWriterHandle = async (key) => {
      if (!key) return null;
      const record = await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.get(key),
        { defaultValue: null },
      );
      if (!record) return null;
      if (record && typeof record === 'object' && 'handle' in record) {
        return record.handle;
      }
      return record;
    };

    const deleteWriterHandle = async (key) => {
      if (!key) return;
      await useStorageTable(
        STORAGE_TABLE_HANDLES,
        (table) => table.delete(key),
        { defaultValue: undefined },
      );
    };

    const parseSegmentSignatureMeta = (signature) => {
      if (typeof signature !== 'string' || signature.length === 0) return null;
      const parts = signature.split(':');
      if (parts.length < 6) return null;
      const [sizeStr, blockDataStr, blockHeaderStr, fileHeaderStr, encryptionStr, segmentSizeStr] = parts;
      const size = Number(sizeStr);
      const segmentSizeBytes = Number(segmentSizeStr);
      if (!Number.isFinite(size) || size <= 0) return null;
      if (!Number.isFinite(segmentSizeBytes) || segmentSizeBytes <= 0) return null;
      return {
        size,
        blockDataSize: Number(blockDataStr) || 0,
        blockHeaderSize: Number(blockHeaderStr) || 0,
        fileHeaderSize: Number(fileHeaderStr) || 0,
        encryption: encryptionStr === 'crypt' ? 'crypt' : 'plain',
        segmentSizeBytes,
      };
    };

    const calculateExpectedSegmentCount = (meta) => {
      if (
        !meta ||
        !Number.isFinite(meta.size) ||
        meta.size <= 0 ||
        !Number.isFinite(meta.segmentSizeBytes) ||
        meta.segmentSizeBytes <= 0
      ) {
        return 0;
      }
      return Math.max(1, Math.ceil(meta.size / meta.segmentSizeBytes));
    };

    const calculatePlainSegmentLength = (meta, index, totalSegments) => {
      if (!meta || !Number.isFinite(meta.segmentSizeBytes) || meta.segmentSizeBytes <= 0) {
        return 0;
      }
      if (index < totalSegments - 1) {
        return meta.segmentSizeBytes;
      }
      const remainder = meta.size % meta.segmentSizeBytes;
      if (remainder === 0) {
        return meta.segmentSizeBytes;
      }
      return remainder;
    };

    const hasCompleteSegmentSet = (records, meta) => {
      const expectedSegments = calculateExpectedSegmentCount(meta);
      if (expectedSegments <= 0) return false;
      if (!Array.isArray(records) || records.length < expectedSegments) {
        return false;
      }
      const indexes = new Set();
      let totalLength = 0;
      let plainLengthMismatch = false;
      records.forEach((record) => {
        if (!record) return;
        const recordIndex = Number(record.index);
        const recordLength = Number(record.length);
        if (!Number.isInteger(recordIndex) || recordIndex < 0) {
          return;
        }
        if (!Number.isFinite(recordLength) || recordLength <= 0) {
          return;
        }
        indexes.add(recordIndex);
        totalLength += recordLength;
        if (meta.encryption === 'plain') {
          const expectedLength = calculatePlainSegmentLength(meta, recordIndex, expectedSegments);
          if (expectedLength <= 0 || recordLength !== expectedLength) {
            plainLengthMismatch = true;
          }
        }
      });
      if (indexes.size < expectedSegments) return false;
      for (let i = 0; i < expectedSegments; i += 1) {
        if (!indexes.has(i)) {
          return false;
        }
      }
      if (meta.encryption === 'plain' && plainLengthMismatch) {
        return false;
      }
      if (!Number.isFinite(totalLength) || totalLength < meta.size) {
        return false;
      }
      return true;
    };

    const cleanupCompletedSegments = async (key) => {
      if (!key) return false;
      const records = await loadPersistedSegmentRecords(key);
      if (!records || records.length === 0) return false;
      const grouped = new Map();
      records.forEach((record) => {
        if (!record || typeof record.signature !== 'string' || record.signature.length === 0) {
          return;
        }
        if (!grouped.has(record.signature)) {
          grouped.set(record.signature, []);
        }
        grouped.get(record.signature).push(record);
      });
      if (grouped.size === 0) return false;
      const preferredSignature =
        state.cacheKey === key ? buildSegmentSignature(buildCurrentMetaForSignature()) : '';
      const candidates = [];
      if (preferredSignature && grouped.has(preferredSignature)) {
        candidates.push({ signature: preferredSignature, records: grouped.get(preferredSignature) });
      }
      grouped.forEach((groupRecords, signature) => {
        if (signature === preferredSignature) return;
        candidates.push({ signature, records: groupRecords });
      });
      for (const candidate of candidates) {
        const meta = parseSegmentSignatureMeta(candidate.signature);
        if (!meta) continue;
        if (!hasCompleteSegmentSet(candidate.records, meta)) {
          continue;
        }
        try {
          await clearSegmentsForKey(key);
        } catch (error) {
          console.warn('清理已完成分段失败', error);
          return false;
        }
        try {
          await deleteWriterHandle(key);
        } catch (error) {
          console.warn('清理已完成分段时删除 writer handle 失败', error);
        }
        return true;
      }
      return false;
    };

    const clearAllStorageForKey = async (key) => {
      await Promise.all([
        removeInfoCache(key),
        clearSegmentsForKey(key),
        deleteWriterHandle(key),
      ]);
    };

    const clearAllStorage = async () => {
      const db = await openStorageDatabase();
      if (!db) return;
      const tables = [STORAGE_TABLE_INFO, STORAGE_TABLE_SEGMENTS, STORAGE_TABLE_HANDLES];
      await Promise.all(
        tables.map(async (tableName) => {
          try {
            await db.table(tableName).clear();
          } catch (error) {
            console.warn('清理 Dexie 表 ' + tableName + ' 失败', error);
          }
        }),
      );
    };

    const loadSettingValue = async (key) => {
      const stored = await useStorageTable(
        STORAGE_TABLE_SETTINGS,
        (table) => table.get(key),
        { defaultValue: null },
      );
      if (!stored) return null;
      if (typeof stored === 'string') return stored;
      if (stored && typeof stored === 'object' && typeof stored.value === 'string') {
        return stored.value;
      }
      return null;
    };

    const persistSettingValue = (key, rawValue) => {
      useStorageTable(
        STORAGE_TABLE_SETTINGS,
        (table) => table.put({ key, value: String(rawValue || '') }),
        { defaultValue: undefined },
      );
    };

    const CONNECTION_SETTING_KEY = 'webdownloader-connections';
    const PARALLEL_SETTING_KEY = 'webdownloader-parallel';
    const SEGMENT_SIZE_SETTING_KEY = 'webdownloader-segment-size-mb';
    const TTFB_TIMEOUT_SETTING_KEY = 'webdownloader-ttfb-timeout';

    const loadConnectionSetting = async () => {
      const stored = await loadSettingValue(CONNECTION_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_CONNECTIONS || parsed > MAX_CONNECTIONS) return null;
      return parsed;
    };

    const loadParallelSetting = async () => {
      const stored = await loadSettingValue(PARALLEL_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_PARALLEL_THREADS || parsed > MAX_PARALLEL_THREADS) return null;
      return parsed;
    };

    const loadSegmentSizeSetting = async () => {
      const stored = await loadSettingValue(SEGMENT_SIZE_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_SEGMENT_SIZE_MB || parsed > MAX_SEGMENT_SIZE_MB) return null;
      return parsed;
    };

    const loadTtfbTimeoutSetting = async () => {
      const stored = await loadSettingValue(TTFB_TIMEOUT_SETTING_KEY);
      if (!stored) return null;
      const parsed = Number.parseInt(stored, 10);
      if (!Number.isFinite(parsed)) return null;
      if (parsed < MIN_TTFB_TIMEOUT_SECONDS || parsed > MAX_TTFB_TIMEOUT_SECONDS) return null;
      return parsed;
    };

    const persistConnectionSetting = (value) => {
      persistSettingValue(CONNECTION_SETTING_KEY, value);
    };

    const persistParallelSetting = (value) => {
      persistSettingValue(PARALLEL_SETTING_KEY, value);
    };

    const persistSegmentSizeSetting = (valueMb) => {
      persistSettingValue(SEGMENT_SIZE_SETTING_KEY, valueMb);
    };

    const persistTtfbTimeoutSetting = (valueSeconds) => {
      persistSettingValue(TTFB_TIMEOUT_SETTING_KEY, valueSeconds);
    };

    const ensureHandlePermission = async (handle) => {
      if (!handle) return false;
      const ensure = async (mode) => {
        if (typeof handle.queryPermission === 'function') {
          const status = await handle.queryPermission({ mode });
          if (status === 'granted') return true;
          if (status === 'prompt' && typeof handle.requestPermission === 'function') {
            const granted = await handle.requestPermission({ mode });
            return granted === 'granted';
          }
          if (status === 'denied' && typeof handle.requestPermission === 'function') {
            const granted = await handle.requestPermission({ mode });
            return granted === 'granted';
          }
          return status === 'granted';
        }
        if (typeof handle.requestPermission === 'function') {
          const granted = await handle.requestPermission({ mode });
          return granted === 'granted';
        }
        return true;
      };
      try {
        return await ensure('readwrite');
      } catch (error) {
        console.warn('文件权限请求失败', error);
        return false;
      }
    };

    const getPersistedWriterHandle = async (key) => {
      if (!key || typeof window === 'undefined') return null;
      if (state.writerHandle && state.writerKey === key) {
        if (await ensureHandlePermission(state.writerHandle)) {
          return state.writerHandle;
        }
      }
      const stored = await loadWriterHandle(key);
      if (!stored) return null;
      const allowed = await ensureHandlePermission(stored);
      if (!allowed) {
        await deleteWriterHandle(key);
        return null;
      }
      state.writerHandle = stored;
      state.writerKey = key;
      return stored;
    };

    const state = {
      enabled: false,
      prepared: false,
      running: false,
      cancelling: false,
      paused: false,
      remote: null,
      meta: null,
      cacheKey: '',
      infoContext: null,
      totalSize: 0,
      totalEncrypted: 0,
      fileName: '',
      encryptionMode: 'plain',
      blockHeaderSize: 0,
      blockDataSize: 0,
      fileHeaderSize: 0,
      dataKey: null,
      baseNonce: null,
      segments: [],
      pendingSegments: [],
      pausedSegments: [],
      failedSegments: new Set(),
      retryTimers: new Map(),
      abortControllers: new Set(),
      writer: null,
      writerHandle: null,
      writerKey: '',
      downloadStartAt: 0,
      downloadedEncrypted: 0,
      bytesSinceSpeedCheck: 0,
      decryptedBytes: 0,
      speedTimer: null,
      speedSamples: [],
      connectionLimit: DEFAULT_CONNECTIONS,
      segmentRetryLimit: DEFAULT_SEGMENT_RETRY_LIMIT,
      segmentRetryRaw: String(DEFAULT_SEGMENT_RETRY_LIMIT),
      segmentSizeMb: DEFAULT_SEGMENT_SIZE_MB,
      segmentSizeRaw: String(DEFAULT_SEGMENT_SIZE_MB),
      ttfbTimeoutSeconds: DEFAULT_TTFB_TIMEOUT_SECONDS,
      ttfbTimeoutRaw: String(DEFAULT_TTFB_TIMEOUT_SECONDS),
      decryptParallelism: DEFAULT_PARALLEL_THREADS,
      decryptParallelRaw: String(DEFAULT_PARALLEL_THREADS),
      workflowPromise: null,
      resumedSegments: 0,
    };

    (async () => {
      try {
        await cleanupExpiredData();
      } catch (cleanupError) {
        console.warn('清理 webDownloader 过期数据失败', cleanupError);
      }
    })();

    const hydrateStoredSettings = async () => {
      try {
        const [storedConnections, storedParallel, storedSegmentSize, storedTtfbTimeout] = await Promise.all([
          loadConnectionSetting(),
          loadParallelSetting(),
          loadSegmentSizeSetting(),
          loadTtfbTimeoutSetting(),
        ]);
        if (Number.isFinite(storedConnections)) {
          state.connectionLimit = storedConnections;
          if (connectionLimitInput) {
            connectionLimitInput.value = String(storedConnections);
          }
        }
        if (Number.isFinite(storedParallel)) {
          state.decryptParallelism = storedParallel;
          state.decryptParallelRaw = String(storedParallel);
          if (parallelLimitInput) {
            parallelLimitInput.value = String(storedParallel);
          }
        }
        if (Number.isFinite(storedSegmentSize)) {
          state.segmentSizeMb = clampSegmentSizeMb(storedSegmentSize);
          state.segmentSizeRaw = String(state.segmentSizeMb);
          if (segmentSizeInput) {
            segmentSizeInput.value = state.segmentSizeRaw;
          }
        }
        if (Number.isFinite(storedTtfbTimeout)) {
          state.ttfbTimeoutSeconds = clampTtfbTimeoutSeconds(storedTtfbTimeout);
          state.ttfbTimeoutRaw = String(state.ttfbTimeoutSeconds);
          if (ttfbTimeoutInput) {
            ttfbTimeoutInput.value = state.ttfbTimeoutRaw;
          }
        }
      } catch (error) {
        console.warn('加载 webDownloader 设置失败', error);
      }
    };

    hydrateStoredSettings();

    const resumeWaiters = [];

    const notifyPendingSegmentWaiters = () => {
      if (pendingSegmentWaiters.length === 0) {
        return;
      }
      const resolvers = pendingSegmentWaiters.splice(0, pendingSegmentWaiters.length);
      resolvers.forEach((resolve) => {
        try {
          resolve();
        } catch (error) {
          console.error('pending segment waiter failed', error);
        }
      });
    };

    const waitForPendingSegment = () =>
      new Promise((resolve) => {
        pendingSegmentWaiters.push(resolve);
      });

    const notifyResumeWaiters = () => {
      if (resumeWaiters.length === 0) {
        return;
      }
      const resolvers = resumeWaiters.splice(0, resumeWaiters.length);
      resolvers.forEach((resolve) => {
        try {
          resolve();
        } catch (error) {
          console.error('resume waiter failed', error);
        }
      });
    };

    const waitForResume = () =>
      new Promise((resolve) => {
        resumeWaiters.push(resolve);
      });

    const cancelScheduledRetry = (index) => {
      if (!Number.isInteger(index)) return;
      const timerId = state.retryTimers.get(index);
      if (timerId) {
        clearTimeout(timerId);
        state.retryTimers.delete(index);
      }
    };

    const clearAllRetryTimers = () => {
      state.retryTimers.forEach((timerId) => {
        clearTimeout(timerId);
      });
      state.retryTimers.clear();
      notifyPendingSegmentWaiters();
    };

    const scheduleSegmentRetry = (segment, delayMs, { prioritize = false, errorMessage = null } = {}) => {
      if (!segment) return;
      const normalizedDelay =
        Number.isFinite(delayMs) && delayMs > 0 ? Math.floor(delayMs) : 0;
      cancelScheduledRetry(segment.index);
      segment.status = 'waiting-retry';
      if (typeof errorMessage === 'string' && errorMessage.length > 0) {
        segment.error = errorMessage;
      }
      const timerId = setTimeout(() => {
        state.retryTimers.delete(segment.index);
        if (state.cancelling) {
          notifyPendingSegmentWaiters();
          return;
        }
        segment.status = 'pending';
        enqueueSegment(segment.index, prioritize);
      }, normalizedDelay);
      state.retryTimers.set(segment.index, timerId);
    };

    const resetUi = () => {
      if (downloadBar) downloadBar.style.width = '0%';
      if (decryptBar) decryptBar.style.width = '0%';
      if (downloadText) downloadText.textContent = '0%';
      if (decryptText) decryptText.textContent = '0%';
      if (speedText) speedText.textContent = '--';
      if (cancelBtn) cancelBtn.disabled = true;
      if (retryFailedSegmentsBtn) retryFailedSegmentsBtn.disabled = true;
      if (clearEnvBtn) clearEnvBtn.disabled = true;
      if (downloadBtn) {
        downloadBtn.disabled = false;
        downloadBtn.textContent = '开始下载';
      }
      document.body.classList.remove('web-downloader-active');
      document.body.classList.remove('client-decrypt-active');
    };

    const activateUi = () => {
      document.body.classList.add('web-downloader-active');
      if (cancelBtn) cancelBtn.disabled = true;
      if (clearEnvBtn) clearEnvBtn.disabled = false;
      syncFailedSegmentsUi();
    };

    const buildRemoteHeaders = () => {
      const headers = new Headers();
      if (state.remote?.headers && typeof state.remote.headers === 'object') {
        Object.entries(state.remote.headers).forEach(([key, value]) => {
          if (!key || value === undefined || value === null) return;
          headers.set(key, String(value));
        });
      }
      headers.set('Accept-Encoding', 'identity');
      return headers;
    };

    const applyProgress = () => {
      if (state.totalEncrypted > 0 && downloadBar && downloadText) {
        const percent = Math.min(100, (state.downloadedEncrypted / state.totalEncrypted) * 100);
        const percentText = percent.toFixed(2) + '%';
        downloadBar.style.width = percentText;
        downloadText.textContent =
          percentText +
          ' (' +
          formatBytes(state.downloadedEncrypted) +
          ' / ' +
          formatBytes(state.totalEncrypted) +
          ')';
      }
      if (state.totalSize > 0 && decryptBar && decryptText) {
        const percent = Math.min(100, (state.decryptedBytes / state.totalSize) * 100);
        const percentText = percent.toFixed(2) + '%';
        decryptBar.style.width = percentText;
        decryptText.textContent =
          percentText +
          ' (' +
          formatBytes(state.decryptedBytes) +
          ' / ' +
          formatBytes(state.totalSize) +
          ')';
      }
    };

    const updateSpeed = () => {
      if (!state.running) {
        if (speedText) speedText.textContent = '--';
        return;
      }
      const now = performance.now();
      state.speedSamples.push({ at: now, bytes: state.downloadedEncrypted });
      while (state.speedSamples.length > 0 && now - state.speedSamples[0].at > SPEED_WINDOW) {
        state.speedSamples.shift();
      }
      if (state.speedSamples.length < 2) {
        if (speedText) speedText.textContent = '--';
        return;
      }
      const first = state.speedSamples[0];
      const last = state.speedSamples[state.speedSamples.length - 1];
      const deltaBytes = last.bytes - first.bytes;
      const deltaTime = (last.at - first.at) / 1000;
      const speed = deltaTime > 0 ? deltaBytes / deltaTime : 0;
      if (speedText) {
        speedText.textContent = formatBytes(speed) + '/s';
      }
    };

    const setWriter = (writer) => {
      state.writer = writer;
    };

    const ensureWriter = async () => {
      if (state.writer) return;
      const key = state.cacheKey;
      if (key) {
        const persistedHandle = await getPersistedWriterHandle(key);
        if (persistedHandle && typeof persistedHandle.createWritable === 'function') {
          try {
            const writable = await persistedHandle.createWritable({ keepExistingData: false });
            setWriter({ type: 'fs', handle: persistedHandle, writable, fallback: [] });
            state.writerHandle = persistedHandle;
            state.writerKey = key;
            if (cancelBtn) cancelBtn.disabled = false;
            log('已复用上次的保存位置：' + (persistedHandle.name || state.fileName));
            return;
          } catch (error) {
            console.warn('复用文件句柄失败，改为重新选择', error);
            await deleteWriterHandle(key);
          }
        }
      }
      if ('showSaveFilePicker' in window) {
        try {
          const handle = await window.showSaveFilePicker({
            suggestedName: state.fileName || 'download.bin',
            types: [{ description: 'Binary file', accept: { 'application/octet-stream': ['.bin'] } }],
          });
          const writable = await handle.createWritable({ keepExistingData: false });
          setWriter({ type: 'fs', handle, writable, fallback: [] });
          state.writerHandle = handle;
          if (key) {
            await saveWriterHandle(key, handle);
            state.writerKey = key;
          }
          if (cancelBtn) cancelBtn.disabled = false;
          log('已选择保存位置：' + (handle.name || state.fileName));
          return;
        } catch (error) {
          log('文件系统访问不可用，改为浏览器下载。原因：' + (error && error.message ? error.message : '未知'));
        }
      }
      setWriter({ type: 'memory', chunks: [] });
      state.writerHandle = null;
      state.writerKey = '';
    };

    const writeChunk = async (chunk) => {
      if (!state.writer) {
        throw new Error('writer 未初始化');
      }
      if (state.writer.type === 'fs') {
        try {
          await state.writer.writable.write(chunk);
          return;
        } catch (error) {
          log('写入文件失败，切换为内存缓冲：' + (error && error.message ? error.message : '未知错误'));
          if (state.writer.writable) {
            try {
              await state.writer.writable.abort();
            } catch (abortError) {
              console.warn('关闭写入器失败', abortError);
            }
          }
          setWriter({ type: 'memory', chunks: [] });
        }
      }
      state.writer.chunks.push(chunk);
    };

    const cleanupSegmentsAfterFinalize = async () => {
      if (!state.cacheKey) return;
      try {
        await clearSegmentsForKey(state.cacheKey);
        await deleteWriterHandle(state.cacheKey);
        log('已清理下载分段数据');
      } catch (error) {
        console.warn('下载完成后清理缓存分段失败', error);
      }
    };

    const finalizeWriter = async () => {
      if (!state.writer) return;
      if (state.writer.type === 'fs') {
        try {
          await state.writer.writable.close();
          log('文件已保存');
        } catch (error) {
          console.error('关闭文件写入器失败', error);
        }
        setWriter(null);
        await cleanupSegmentsAfterFinalize();
        return;
      }
      const blob = new Blob(state.writer.chunks, { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = state.fileName || 'download.bin';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (state.writer.chunks) state.writer.chunks.length = 0;
      log('已触发浏览器下载');
      setWriter(null);
      await cleanupSegmentsAfterFinalize();
    };

    const decodeDownloadUrl = (download) => {
      if (download.urlBase64) {
        try {
          return atob(download.urlBase64);
        } catch (error) {
          console.warn('download.urlBase64 解码失败，回退到 url', error);
        }
      }
      return download.url;
    };

    const fetchCryptHeader = async () => {
      if (state.encryptionMode !== 'crypt' || state.baseNonce) return;
      if (!Number.isFinite(state.fileHeaderSize) || state.fileHeaderSize <= 0) {
        throw new Error('缺少 crypt header 尺寸配置');
      }
      const headers = buildRemoteHeaders();
      headers.set('Range', 'bytes=0-' + (state.fileHeaderSize - 1));
      const response = await fetch(state.remote.url, {
        method: state.remote.method || 'GET',
        headers,
      });
      if (!(response.ok || response.status === 206)) {
        throw new Error('获取 crypt header 失败，HTTP ' + response.status);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.length < state.fileHeaderSize) {
         throw new Error('crypt header 长度不足');
      }
      const magic = [82, 67, 76, 79, 78, 69, 0, 0];
      for (let i = 0; i < magic.length; i += 1) {
        if (buffer[i] !== magic[i]) {
          throw new Error('crypt header 魔数不匹配');
        }
      }
      const nonceStart = magic.length;
        const nonceEnd = nonceStart + CRYPT_NONCE_SIZE;
        state.baseNonce = cloneUint8(buffer.subarray(nonceStart, nonceEnd));
        if (!state.baseNonce || state.baseNonce.length !== CRYPT_NONCE_SIZE) {
          throw new Error('crypt header 中 nonce 无效');
        }
    };

    const createSegments = () => {
      const fileSize = state.totalSize;
      if (!Number.isFinite(fileSize) || fileSize <= 0) {
        throw new Error('文件大小未知，无法启用 webDownloader');
      }
      const segments = [];
      let offset = 0;
      let index = 0;
      const segmentSizeBytes = toSegmentSizeBytes(state.segmentSizeMb);
      const meta = {
        encryption: state.encryptionMode,
        blockDataSize: state.blockDataSize,
        blockHeaderSize: state.blockHeaderSize,
        fileHeaderSize: state.fileHeaderSize,
        size: state.totalSize,
      };
      let encryptedTotal = 0;
      while (offset < fileSize) {
        const length = Math.min(segmentSizeBytes, fileSize - offset);
        const mapping = calculateUnderlying(offset, length, meta);
        const encryptedSize = Number.isFinite(mapping.underlyingLimit) && mapping.underlyingLimit > 0
          ? mapping.underlyingLimit
          : length;
        encryptedTotal += encryptedSize;
        segments.push({
          index,
          offset,
          length,
          mapping,
          encrypted: null,
          retries: 0,
          status: 'pending',
          error: null,
        });
        offset += length;
        index += 1;
      }
      state.segments = segments;
      state.pendingSegments = segments.map((segment) => segment.index);
      state.pausedSegments = [];
      state.paused = false;
      state.failedSegments = new Set();
      state.totalEncrypted = encryptedTotal > 0 ? encryptedTotal : fileSize;
      state.downloadedEncrypted = 0;
      state.bytesSinceSpeedCheck = 0;
      state.decryptedBytes = 0;
      state.resumedSegments = 0;
      syncFailedSegmentsUi();
      notifyPendingSegmentWaiters();
    };

    const syncFailedSegmentsUi = () => {
      if (!retryFailedSegmentsBtn) return;
      const failedCount = state.failedSegments.size;
      retryFailedSegmentsBtn.disabled = failedCount === 0;
      retryFailedSegmentsBtn.textContent =
        failedCount > 0 ? '重试失败片段 (' + failedCount + ')' : '重试失败片段';
    };

    const restoreSegmentsFromCache = async () => {
      state.pausedSegments = [];
      state.paused = false;
      if (!state.cacheKey || state.segments.length === 0) {
        state.pendingSegments = state.segments.map((segment) => segment.index);
        state.failedSegments.clear();
        syncFailedSegmentsUi();
        return 0;
      }
      const signature = buildSegmentSignature(buildCurrentMetaForSignature());
      const records = await loadPersistedSegmentRecords(state.cacheKey);
      const persistedMap = new Map();
      records.forEach((record) => {
        if (!record || record.signature !== signature) {
          return;
        }
        const index = Number(record.index);
        if (!Number.isInteger(index) || index < 0) {
          return;
        }
        const cloned = clonePersistedSegment(record.data);
        if (cloned && cloned.length > 0) {
          persistedMap.set(index, cloned);
        }
      });
      let reused = 0;
      let encryptedTotal = 0;
      state.pendingSegments = [];
      state.segments.forEach((segment) => {
        segment.retries = 0;
        segment.error = null;
        segment.status = 'pending';
        const buffer = persistedMap.get(segment.index);
        if (buffer && buffer.length > 0) {
          segment.encrypted = buffer;
          segment.status = 'done';
          encryptedTotal += buffer.length;
          reused += 1;
        } else {
          segment.encrypted = null;
          state.pendingSegments.push(segment.index);
        }
      });
      state.downloadedEncrypted = encryptedTotal;
      state.bytesSinceSpeedCheck = 0;
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      state.resumedSegments = reused;
      applyProgress();
      notifyPendingSegmentWaiters();
      return reused;
    };

    const enqueueSegment = (index, prioritize = false) => {
      if (!Number.isInteger(index)) return;
      const segment = state.segments[index];
      if (!segment || segment.status === 'done') return;
      if (segment.status !== 'pending') {
        segment.status = 'pending';
      }
      cancelScheduledRetry(index);
      const targetQueue = state.paused ? state.pausedSegments : state.pendingSegments;
      if (prioritize) {
        targetQueue.unshift(index);
      } else {
        targetQueue.push(index);
      }
      if (!state.paused) {
        notifyPendingSegmentWaiters();
      }
    };

    const takeNextSegmentIndex = () => {
      while (state.pendingSegments.length > 0) {
        const index = state.pendingSegments.shift();
        if (!Number.isInteger(index)) {
          continue;
        }
        const segment = state.segments[index];
        if (!segment) {
          continue;
        }
        if (segment.encrypted && segment.status === 'done') {
          continue;
        }
        if (segment.status === 'downloading') {
          continue;
        }
        segment.status = 'downloading';
        return index;
      }
      return undefined;
    };

    const recordSegmentFailure = (segment, errorMessage) => {
      if (!segment) return;
      segment.status = 'failed';
      segment.error = errorMessage || null;
      state.failedSegments.add(segment.index);
      syncFailedSegmentsUi();
    };

    const downloadSegment = async (index) => {
      const segment = state.segments[index];
      if (!segment) return;
      let attempt = Number(segment.retries) || 0;
      while (true) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        const headers = buildRemoteHeaders();
        const start = Number(segment.mapping.underlyingOffset) || 0;
        const limit = Number(segment.mapping.underlyingLimit) || segment.length;
        const end = limit > 0 ? start + limit - 1 : start + segment.length - 1;
        headers.set('Range', 'bytes=' + start + '-' + end);
        const controller = new AbortController();
        state.abortControllers.add(controller);
        let ttfbTimer = null;
        let ttfbTimedOut = false;
        const cancelTtfbTimer = () => {
          if (ttfbTimer) {
            clearTimeout(ttfbTimer);
            ttfbTimer = null;
          }
        };
        const ttfbTimeoutMs = toTtfbTimeoutMs(state.ttfbTimeoutSeconds);
        if (Number.isFinite(ttfbTimeoutMs) && ttfbTimeoutMs > 0) {
          ttfbTimer = setTimeout(() => {
            ttfbTimedOut = true;
            try {
              controller.abort();
            } catch (abortError) {
              console.warn('TTFB 超时取消请求失败', abortError);
            }
          }, ttfbTimeoutMs);
        }
        try {
          const response = await fetch(state.remote.url, {
            method: state.remote.method || 'GET',
            headers,
            signal: controller.signal,
          });
          cancelTtfbTimer();
          if (!(response.ok || response.status === 206)) {
            throw new Error('分段下载失败，HTTP ' + response.status);
          }
          const buffer = new Uint8Array(await response.arrayBuffer());
          state.downloadedEncrypted = Math.min(
            state.totalEncrypted,
            state.downloadedEncrypted + buffer.length,
          );
          state.bytesSinceSpeedCheck += buffer.length;
          applyProgress();
          cancelScheduledRetry(segment.index);
          let payload = buffer;
          if (state.encryptionMode === 'plain' && buffer.length > segment.length) {
            const excess = buffer.length - segment.length;
            payload = buffer.subarray(0, segment.length);
            state.downloadedEncrypted = Math.max(0, state.downloadedEncrypted - excess);
            state.bytesSinceSpeedCheck = Math.max(0, state.bytesSinceSpeedCheck - excess);
          }
          segment.encrypted = payload;
          segment.status = 'done';
          segment.error = null;
          segment.retries = 0;
          state.failedSegments.delete(segment.index);
          syncFailedSegmentsUi();
          if (state.cacheKey) {
            await persistSegmentData(
              state.cacheKey,
              segment.index,
              payload,
              buildCurrentMetaForSignature()
            );
          }
          return;
        } catch (error) {
          cancelTtfbTimer();
          if (state.cancelling) {
            throw error instanceof Error ? error : new Error(String(error || 'cancelled'));
          }
          if (state.paused) {
            segment.status = 'pending';
            segment.error = null;
            state.failedSegments.delete(segment.index);
            enqueueSegment(segment.index, true);
            return;
          }
          const rawMessage = error instanceof Error && error.message ? error.message : String(error || '未知错误');
          const isTtfbTimeout = ttfbTimedOut && controller.signal.aborted;
          const message = isTtfbTimeout ? '等待服务器响应超时' : rawMessage;
          attempt += 1;
          segment.retries = attempt;
          const retryLimit = state.segmentRetryLimit;
          const shouldRetry = Number.isFinite(retryLimit) ? attempt <= retryLimit : true;
          if (shouldRetry) {
            if (isTtfbTimeout) {
              segment.error = message;
              state.failedSegments.delete(segment.index);
              scheduleSegmentRetry(segment, 0, { prioritize: true, errorMessage: message });
              log(
                '分段 #' +
                  (segment.index + 1) +
                  ' ' +
                  message +
                  '（>' +
                  clampTtfbTimeoutSeconds(state.ttfbTimeoutSeconds) +
                  's）已重新排队等待新的连接。'
              );
              return;
            }
            const isHttp429 = typeof message === 'string' && message.includes('HTTP 429');
            let retryDelayMs = RETRY_DELAY_MS;
            let shouldLogRetry = true;
            if (isHttp429) {
              if (attempt <= HTTP429_SILENT_RETRY_LIMIT) {
                retryDelayMs = HTTP429_BASE_DELAY_MS;
                shouldLogRetry = false;
              } else {
                const exponent = attempt - HTTP429_SILENT_RETRY_LIMIT;
                const exponentialDelay = HTTP429_BASE_DELAY_MS * Math.pow(2, Math.max(0, exponent - 1));
                retryDelayMs = Math.min(HTTP429_MAX_DELAY_MS, exponentialDelay);
              }
            }
            if (shouldLogRetry) {
              log(
                '分段 #' +
                  (segment.index + 1) +
                  ' 下载失败：' +
                  message +
                  '，将在 ' +
                  (retryDelayMs / 1000).toFixed(0) +
                  ' 秒后重试（第 ' +
                  attempt +
                  ' 次）'
              );
            }
            segment.error = message;
            state.failedSegments.delete(segment.index);
            scheduleSegmentRetry(segment, retryDelayMs, { errorMessage: message });
            return;
          }
          recordSegmentFailure(segment, message);
          throw error instanceof Error ? error : new Error(message);
        } finally {
          state.abortControllers.delete(controller);
          try {
            controller.abort();
          } catch (abortError) {
            console.warn('中止分段请求失败', abortError);
          }
        }
      }
    };

    const decryptSegmentData = async (segment) => {
      if (!segment || !segment.encrypted) {
        throw new Error('缺少分段数据');
      }
      if (state.encryptionMode === 'plain') {
        return segment.encrypted.subarray(0, segment.length);
      }
      const buffer = segment.encrypted;
      const output = new Uint8Array(segment.length);
      let produced = 0;
      let blockIndex = segment.mapping.blocks;
      let discard = segment.mapping.discard;
      let offset = 0;
      while (offset < buffer.length && produced < segment.length) {
        if (offset + state.blockHeaderSize > buffer.length) break;
        let end = offset + state.blockHeaderSize + state.blockDataSize;
        if (end > buffer.length) {
          end = buffer.length;
        }
        const cipherBlock = buffer.subarray(offset, end);
        offset = end;
        const plainBlock = decryptBlock(cipherBlock, state.dataKey, state.baseNonce, blockIndex);
        if (!plainBlock) {
          throw new Error('解密失败，请重试');
        }
        let chunk = plainBlock;
        if (blockIndex === segment.mapping.blocks && discard > 0) {
          if (chunk.length <= discard) {
            discard -= chunk.length;
            blockIndex += 1;
            continue;
          }
          chunk = chunk.subarray(discard);
          discard = 0;
        }
        const remaining = segment.length - produced;
        if (chunk.length > remaining) {
          output.set(chunk.subarray(0, remaining), produced);
          produced += remaining;
          break;
        }
        output.set(chunk, produced);
        produced += chunk.length;
        blockIndex += 1;
      }
      if (produced !== segment.length) {
        throw new Error('解密输出长度不匹配');
      }
      return output;
    };

    const clampParallelThreads = (value) => {
      if (!Number.isFinite(value)) {
        return DEFAULT_PARALLEL_THREADS;
      }
      const rounded = Math.floor(value);
      if (rounded < MIN_PARALLEL_THREADS) return MIN_PARALLEL_THREADS;
      if (rounded > MAX_PARALLEL_THREADS) return MAX_PARALLEL_THREADS;
      return rounded;
    };

    const resolveParallelism = () => {
      const configured = clampParallelThreads(state.decryptParallelism);
      if (typeof navigator !== 'undefined' && navigator && Number.isFinite(navigator.hardwareConcurrency)) {
        const hardwareClamped = clampParallelThreads(navigator.hardwareConcurrency);
        return Math.max(MIN_PARALLEL_THREADS, Math.min(configured, hardwareClamped));
      }
      return configured;
    };

    const decryptAllSegments = async () => {
      if (state.segments.length === 0) return;
      setStatus('下载完成，准备解密');
      const totalSegments = state.segments.length;
      const parallelism = Math.min(resolveParallelism(), totalSegments);
      const commonParams = {
        dataKey: state.dataKey,
        baseNonce: state.baseNonce,
        blockHeaderSize: state.blockHeaderSize,
        blockDataSize: state.blockDataSize,
        encryptionMode: state.encryptionMode,
      };
      let writtenSegments = 0;

      await runSegmentDecryptionTask({
        mode: 'webDownloader',
        segments: state.segments,
        parallelism,
        commonParams,
        isCancelled: () => state.cancelling,
        getPayload: async (index) => {
          const segment = state.segments[index];
          if (!segment || !segment.encrypted) {
            throw new Error('缺少分段数据');
          }
          return {
            length: segment.length,
            mapping: segment.mapping,
            encrypted: segment.encrypted,
          };
        },
        writeOrderedChunk: async (index, chunk) => {
          if (state.cancelling) {
            throw new Error('cancelled');
          }
          await writeChunk(chunk);
          state.decryptedBytes = Math.min(state.totalSize, state.decryptedBytes + chunk.length);
          const finishedSegment = state.segments[index];
          if (finishedSegment) {
            finishedSegment.encrypted = null;
          }
          writtenSegments = index + 1;
          applyProgress();
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      });
      if (writtenSegments !== totalSegments) {
        throw new Error('仍有分段未完成解密');
      }
    };

    const writePlainSegments = async () => {
      for (let i = 0; i < state.segments.length; i += 1) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        const segment = state.segments[i];
        if (!segment || !segment.encrypted) {
          throw new Error('缺少分段数据');
        }
        const payload = segment.encrypted.subarray(0, segment.length);
        await writeChunk(payload);
        state.decryptedBytes = Math.min(state.totalSize, state.decryptedBytes + payload.length);
        segment.encrypted = null;
        applyProgress();
        if (state.decryptedBytes < state.totalSize) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    const downloadAllSegments = async () => {
      if (state.segments.length === 0) {
        return;
      }
      const connectionLimit = clamp(state.connectionLimit, MIN_CONNECTIONS, MAX_CONNECTIONS, DEFAULT_CONNECTIONS);
      const inFlight = new Set();
      let lastDispatchAt = 0;
      const rateDelay = async () => {
        const now = performance.now();
        const elapsed = now - lastDispatchAt;
        if (elapsed < REQUEST_INTERVAL_MS) {
          await sleep(REQUEST_INTERVAL_MS - elapsed);
        }
        lastDispatchAt = performance.now();
      };
      const launchDownload = (index) => {
        const task = (async () => {
          await downloadSegment(index);
        })().finally(() => {
          inFlight.delete(task);
        });
        inFlight.add(task);
        return task;
      };
      while (true) {
        if (state.cancelling) {
          throw new Error('cancelled');
        }
        if (state.paused) {
          await waitForResume();
          continue;
        }
        if (inFlight.size >= connectionLimit) {
          await Promise.race(inFlight);
          continue;
        }
        const nextIndex = takeNextSegmentIndex();
        if (nextIndex === undefined) {
          if (inFlight.size === 0) {
            if (state.retryTimers.size === 0) {
              break;
            }
            await waitForPendingSegment();
            continue;
          }
          await Promise.race(inFlight);
          continue;
        }
        launchDownload(nextIndex);
        await rateDelay();
      }
      await Promise.all(inFlight);
      const unfinished = state.segments.find((segment) => !segment.encrypted);
      if (unfinished) {
        throw new Error('仍有分段未完成下载');
      }
    };

    const startWorkflow = async () => {
      if (state.workflowPromise) return state.workflowPromise;
      if (!state.prepared) {
        throw new Error('webDownloader 未准备就绪');
      }
      state.paused = false;
      state.pausedSegments.length = 0;
      notifyResumeWaiters();
      state.workflowPromise = (async () => {
        state.running = true;
        state.cancelling = false;
        state.abortControllers = new Set();
        state.downloadedEncrypted = state.downloadedEncrypted || 0;
        state.decryptedBytes = state.decryptedBytes || 0;
        applyProgress();
        if (downloadBtn) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = '暂停下载';
        }
        if (cancelBtn) cancelBtn.disabled = false;
        if (clearEnvBtn) clearEnvBtn.disabled = true;
        setStatus('开始下载，准备文件...');
        try {
          const autoRequeued = requeueFailedSegments({ silent: true });
          if (autoRequeued) {
            log('已自动重新排队之前失败的分段');
          }
          if (state.encryptionMode === 'crypt') {
            if (!window.nacl || !window.nacl.secretbox || !window.nacl.secretbox.open) {
              throw new Error('TweetNaCl 初始化失败，请刷新页面重试');
            }
          }
          await ensureWriter();
          if (state.encryptionMode === 'crypt' && !state.baseNonce) {
            await fetchCryptHeader();
          }
          state.downloadStartAt = performance.now();
          if (state.speedTimer) clearInterval(state.speedTimer);
          state.speedTimer = setInterval(updateSpeed, 1000);
          await downloadAllSegments();
          if (state.encryptionMode === 'crypt') {
            await decryptAllSegments();
          } else {
            await writePlainSegments();
          }
          await finalizeWriter();
          if (speedText) speedText.textContent = '--';
          setStatus('下载完成');
        } catch (error) {
          if (speedText) speedText.textContent = '--';
          if (state.cancelling) {
            setStatus('下载已取消');
          } else {
            const message = error instanceof Error && error.message ? error.message : String(error || '未知错误');
            setStatus('下载失败：' + message);
            console.error(error);
          }
          throw error;
        } finally {
          state.running = false;
          if (state.speedTimer) {
            clearInterval(state.speedTimer);
            state.speedTimer = null;
          }
          if (cancelBtn) cancelBtn.disabled = true;
          if (clearEnvBtn) clearEnvBtn.disabled = false;
          syncFailedSegmentsUi();
          if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.textContent = '重新下载';
          }
          state.workflowPromise = null;
        }
      })();
      return state.workflowPromise;
    };

    const cancelDownload = async () => {
      if (!state.running) return;
      state.cancelling = true;
      state.paused = false;
      state.pausedSegments.length = 0;
      state.pendingSegments.length = 0;
      notifyResumeWaiters();
      notifyPendingSegmentWaiters();
      clearAllRetryTimers();
      state.abortControllers?.forEach((controller) => {
        try {
          controller.abort();
        } catch (error) {
          console.warn('取消请求失败', error);
        }
      });
      state.abortControllers = new Set();
      setStatus('正在取消下载...');
    };

    const pauseDownload = () => {
      if (!state.running || state.paused) return;
      state.paused = true;
      if (state.pendingSegments.length > 0) {
        state.pausedSegments = state.pausedSegments.concat(state.pendingSegments);
        state.pendingSegments.length = 0;
      }
      notifyPendingSegmentWaiters();
      state.abortControllers?.forEach((controller) => {
        try {
          controller.abort();
        } catch (error) {
          console.warn('暂停下载时中止请求失败', error);
        }
      });
      if (downloadBtn) {
        downloadBtn.textContent = '恢复下载';
      }
      setStatus('下载已暂停，点击恢复下载继续。');
      if (speedText) speedText.textContent = '--';
    };

    const resumeDownload = () => {
      if (!state.running || !state.paused) return;
      state.paused = false;
      if (state.pausedSegments.length > 0) {
        state.pendingSegments = state.pausedSegments.concat(state.pendingSegments);
        state.pausedSegments.length = 0;
      }
      notifyResumeWaiters();
      notifyPendingSegmentWaiters();
      if (downloadBtn) {
        downloadBtn.textContent = '暂停下载';
      }
      setStatus('继续下载...');
    };

    const normalizeDownloadInfo = (info) => {
      if (!info || !info.download) {
        throw new Error('缺少下载信息');
      }
      const remote = {
        url: decodeDownloadUrl(info.download),
        method: info.download.remote?.method || 'GET',
        headers: info.download.remote?.headers || {},
      };
      const remoteLength = Number(info.download.remote?.length);
      const metaSize = Number(info.meta?.size);
      let totalSize = 0;
      if (Number.isFinite(remoteLength) && remoteLength > 0) {
        totalSize = remoteLength;
      } else if (Number.isFinite(metaSize) && metaSize > 0) {
        totalSize = metaSize;
      }
      const downloadMeta = info.download.meta || {};
      const encryptionMode = downloadMeta.encryption === 'crypt' ? 'crypt' : 'plain';
      const blockHeaderSize = Number(downloadMeta.blockHeaderSize) || 0;
      const blockDataSize = Number(downloadMeta.blockDataSize) || 0;
      const fileHeaderSize = Number(downloadMeta.fileHeaderSize) || 0;
      const dataKey = downloadMeta.dataKey ? base64ToUint8(downloadMeta.dataKey) : null;
      const meta = info.meta && typeof info.meta === 'object' ? { ...info.meta } : {};
      meta.size = totalSize;
      const fileNameCandidate =
        typeof meta.fileName === 'string' && meta.fileName.trim().length > 0 ? meta.fileName.trim() : '';
      let fallbackName = '';
      if (!fileNameCandidate && typeof meta.path === 'string' && meta.path) {
        const parts = meta.path.split('/').filter(Boolean);
        fallbackName = parts.length > 0 ? parts[parts.length - 1] : '';
      }
      const fileName = fileNameCandidate || fallbackName || 'download.bin';
      return {
        remote,
        totalSize,
        meta,
        encryptionMode,
        blockHeaderSize,
        blockDataSize,
        fileHeaderSize,
        dataKey,
        fileName,
      };
    };

    const prepareFromInfo = async (info, { autoStart = false, path = '', sign = '' } = {}) => {
      const normalized = normalizeDownloadInfo(info);
      state.enabled = true;
      state.prepared = false;
      state.running = false;
      state.cancelling = false;
      state.paused = false;
      state.pausedSegments = [];
      state.remote = normalized.remote;
      state.meta = normalized.meta;
      state.fileName = normalized.fileName;
      state.totalSize =
        Number.isFinite(normalized.totalSize) && normalized.totalSize > 0 ? normalized.totalSize : 0;
      state.encryptionMode = normalized.encryptionMode;
      state.blockHeaderSize = Number(normalized.blockHeaderSize) || 0;
      state.blockDataSize = Number(normalized.blockDataSize) || 0;
      state.fileHeaderSize = Number(normalized.fileHeaderSize) || 0;
      state.dataKey = normalized.dataKey;
      state.baseNonce = null;
      if (state.encryptionMode === 'crypt' && (!state.dataKey || state.dataKey.length === 0)) {
        throw new Error('缺少 CRYPT_DATA_KEY，无法解密文件');
      }
      state.infoContext = { path, sign };
      state.cacheKey = path ? buildCacheKey(path, sign) : '';
      if (state.cacheKey && info) {
        await saveInfoToCache(state.cacheKey, info);
      }
      state.connectionLimit = clamp(
        Number(connectionLimitInput?.value) || state.connectionLimit || DEFAULT_CONNECTIONS,
        MIN_CONNECTIONS,
        MAX_CONNECTIONS,
        DEFAULT_CONNECTIONS
      );
      if (connectionLimitInput) {
        connectionLimitInput.value = String(state.connectionLimit);
      }
      const fallbackSegmentSize = state.segmentSizeMb || DEFAULT_SEGMENT_SIZE_MB;
      const rawSegmentSize = Number(segmentSizeInput?.value);
      state.segmentSizeMb = clampSegmentSizeMb(
        Number.isFinite(rawSegmentSize) && rawSegmentSize > 0 ? rawSegmentSize : fallbackSegmentSize,
      );
      state.segmentSizeRaw = String(state.segmentSizeMb);
      if (segmentSizeInput) {
        segmentSizeInput.value = state.segmentSizeRaw;
      }
      const fallbackTtfb = state.ttfbTimeoutSeconds || DEFAULT_TTFB_TIMEOUT_SECONDS;
      const rawTtfb = Number(ttfbTimeoutInput?.value);
      state.ttfbTimeoutSeconds = clampTtfbTimeoutSeconds(
        Number.isFinite(rawTtfb) && rawTtfb > 0 ? rawTtfb : fallbackTtfb,
      );
      state.ttfbTimeoutRaw = String(state.ttfbTimeoutSeconds);
      if (ttfbTimeoutInput) {
        ttfbTimeoutInput.value = state.ttfbTimeoutRaw;
      }
      const rawRetry = (retryLimitInput && retryLimitInput.value || '').trim().toLowerCase();
      if (rawRetry === INFINITE_RETRY_TOKEN) {
        state.segmentRetryLimit = Infinity;
        state.segmentRetryRaw = INFINITE_RETRY_TOKEN;
      } else if (rawRetry) {
        const parsedRetry = Number.parseInt(rawRetry, 10);
        state.segmentRetryLimit = Number.isFinite(parsedRetry) && parsedRetry >= 0 ? parsedRetry : DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(state.segmentRetryLimit);
      } else {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
      }
      if (retryLimitInput) {
        retryLimitInput.value = state.segmentRetryRaw;
      }
      const rawParallel = (parallelLimitInput && parallelLimitInput.value) || state.decryptParallelRaw;
      if (rawParallel) {
        const parsedParallel = Number.parseInt(rawParallel, 10);
        if (Number.isFinite(parsedParallel)) {
          state.decryptParallelism = clampParallelThreads(parsedParallel);
          state.decryptParallelRaw = String(state.decryptParallelism);
          if (parallelLimitInput) {
            parallelLimitInput.value = state.decryptParallelRaw;
          }
        }
      }
      if (state.cacheKey) {
        const cleanedCompletedSegments = await cleanupCompletedSegments(state.cacheKey);
        if (cleanedCompletedSegments) {
          log('检测到已完成的历史任务缓存，已自动清理分段数据。');
        }
      }
      state.downloadedEncrypted = 0;
      state.decryptedBytes = 0;
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      createSegments();
      const reused = await restoreSegmentsFromCache();
      activateUi();
      applyProgress();
      if (reused > 0) {
        log('已复用 ' + reused + ' 个已下载分段，可继续下载剩余部分。');
        setStatus('准备就绪，保留了 ' + reused + ' 个已完成分段。');
      } else {
        setStatus('准备就绪，点击开始下载');
      }
      state.prepared = true;
      if (downloadBtn) {
        downloadBtn.textContent = '开始下载';
        downloadBtn.disabled = false;
      }
      if (autoStart) {
        startWorkflow().catch((error) => console.error(error));
      }
    };

    const prepareFromCache = async ({ path = '', sign = '', autoStart = false } = {}) => {
      if (!path) return null;
      const key = buildCacheKey(path, sign);
      if (!key) return null;
      const cached = await loadCachedInfo(key);
      if (!cached || !cached.download) {
        return null;
      }
      const cleaned = await cleanupCompletedSegments(key);
      if (cleaned) {
        log('检测到已完成的缓存任务，已自动清理残留分段。');
      }
      await prepareFromInfo(cached, { autoStart, path, sign });
      return cached;
    };

    const refreshFromInfo = async (info, { autoStart = false, path = '', sign = '' } = {}) => {
      if (!info || !info.download) {
        throw new Error('缺少下载信息');
      }
      if (!state.prepared) {
        await prepareFromInfo(info, { autoStart, path, sign });
        return;
      }
      const normalized = normalizeDownloadInfo(info);
      const nextMetaSignature = buildSegmentSignature({
        size: normalized.totalSize,
        blockDataSize: normalized.blockDataSize,
        blockHeaderSize: normalized.blockHeaderSize,
        fileHeaderSize: normalized.fileHeaderSize,
        encryption: normalized.encryptionMode,
        segmentSizeBytes: toSegmentSizeBytes(state.segmentSizeMb),
      });
      const currentSignature = buildSegmentSignature(buildCurrentMetaForSignature());
      const dataKeyEqual = areUint8ArraysEqual(normalized.dataKey, state.dataKey);
      const compatible = nextMetaSignature === currentSignature && dataKeyEqual;
      if (!compatible) {
        if (state.running) {
          log('检测到下载配置变化，当前任务需取消后重新开始。');
          setStatus('下载配置已更新，请取消后重新开始。');
          return;
        }
        await prepareFromInfo(info, { autoStart, path, sign });
        return;
      }
      state.remote = normalized.remote;
      state.meta = normalized.meta;
      state.fileName = normalized.fileName;
      state.totalSize = normalized.totalSize;
      state.blockHeaderSize = Number(normalized.blockHeaderSize) || 0;
      state.blockDataSize = Number(normalized.blockDataSize) || 0;
      state.fileHeaderSize = Number(normalized.fileHeaderSize) || 0;
      if (normalized.dataKey && normalized.dataKey.length > 0) {
        state.dataKey = normalized.dataKey;
      }
      state.infoContext = { path, sign };
      if (!state.cacheKey && path) {
        state.cacheKey = buildCacheKey(path, sign);
      }
      if (state.cacheKey) {
        await saveInfoToCache(state.cacheKey, info);
      }
      log('已刷新下载链接，可继续当前任务。');
    };

    const handlePrimaryAction = () => {
      if (!state.prepared) return;
      if (state.running) {
        // 已在运行中：切换暂停/恢复
        if (state.paused) {
          // 当前已暂停 → 恢复下载
          resumeDownload();
        } else {
          // 当前未暂停 → 暂停下载
          pauseDownload();
        }
        return;
      }
      // 未运行 → 开始下载
      startWorkflow().catch((error) => {
        console.error(error);
        setStatus('下载失败：' + (error && error.message ? error.message : '未知错误'));
      });
    };

    const reset = () => {
      state.enabled = false;
      state.prepared = false;
      state.running = false;
      state.paused = false;
      state.remote = null;
      state.meta = null;
      state.dataKey = null;
      state.baseNonce = null;
      state.infoContext = null;
      state.cacheKey = '';
      state.totalSize = 0;
      state.totalEncrypted = 0;
      state.fileName = '';
      state.encryptionMode = 'plain';
      state.blockHeaderSize = 0;
      state.blockDataSize = 0;
      state.fileHeaderSize = 0;
      state.segments = [];
      state.pendingSegments = [];
      state.pausedSegments = [];
      state.failedSegments.clear();
      clearAllRetryTimers();
      state.writer = null;
      state.writerHandle = null;
      state.writerKey = '';
      state.downloadedEncrypted = 0;
      state.decryptedBytes = 0;
      state.bytesSinceSpeedCheck = 0;
      state.downloadStartAt = 0;
      state.speedSamples = [];
      state.workflowPromise = null;
      state.abortControllers = new Set();
      if (state.speedTimer) {
        clearInterval(state.speedTimer);
        state.speedTimer = null;
      }
      notifyResumeWaiters();
      resetUi();
    };

    const requeueFailedSegments = ({ silent = false } = {}) => {
      if (state.failedSegments.size === 0) return false;
      state.failedSegments.forEach((index) => {
        const segment = state.segments[index];
        if (!segment) return;
        segment.encrypted = null;
        segment.retries = 0;
        segment.status = 'pending';
        segment.error = null;
        enqueueSegment(index, true);
      });
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      if (!silent) {
        setStatus('失败分段已重新排队，点击开始下载继续。');
      }
      return true;
    };

    const retryFailedSegments = () => {
      requeueFailedSegments({ silent: false });
    };

    const clearStoredTasks = async () => {
      if (state.cacheKey) {
        await clearAllStorageForKey(state.cacheKey);
      } else {
        await clearAllStorage();
      }
      state.failedSegments.clear();
      syncFailedSegmentsUi();
      reset();
      setStatus('已清理所有已保存的任务数据。');
    };

    const updateConnectionLimit = (value) => {
      state.connectionLimit = clamp(Number(value), MIN_CONNECTIONS, MAX_CONNECTIONS, DEFAULT_CONNECTIONS);
      if (connectionLimitInput) {
        connectionLimitInput.value = String(state.connectionLimit);
      }
      persistConnectionSetting(state.connectionLimit);
    };

    const updateRetryLimit = (value) => {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!raw) {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      if (raw === INFINITE_RETRY_TOKEN) {
        state.segmentRetryLimit = Infinity;
        state.segmentRetryRaw = INFINITE_RETRY_TOKEN;
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        state.segmentRetryLimit = DEFAULT_SEGMENT_RETRY_LIMIT;
        state.segmentRetryRaw = String(DEFAULT_SEGMENT_RETRY_LIMIT);
        if (retryLimitInput) {
          retryLimitInput.value = state.segmentRetryRaw;
        }
        return;
      }
      state.segmentRetryLimit = parsed;
      state.segmentRetryRaw = String(parsed);
      if (retryLimitInput) {
        retryLimitInput.value = state.segmentRetryRaw;
      }
    };

    const updateParallelLimit = (value) => {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) {
        state.decryptParallelism = DEFAULT_PARALLEL_THREADS;
        state.decryptParallelRaw = String(DEFAULT_PARALLEL_THREADS);
        if (parallelLimitInput) {
          parallelLimitInput.value = state.decryptParallelRaw;
        }
        persistParallelSetting(state.decryptParallelism);
        return;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        return;
      }
      state.decryptParallelism = clampParallelThreads(parsed);
      state.decryptParallelRaw = String(state.decryptParallelism);
      if (parallelLimitInput) {
        parallelLimitInput.value = state.decryptParallelRaw;
      }
      persistParallelSetting(state.decryptParallelism);
    };

    const updateSegmentSize = (value) => {
      const parsed = Number(value);
      state.segmentSizeMb = clampSegmentSizeMb(parsed);
      state.segmentSizeRaw = String(state.segmentSizeMb);
      if (segmentSizeInput) {
        segmentSizeInput.value = state.segmentSizeRaw;
      }
      persistSegmentSizeSetting(state.segmentSizeMb);
    };

    const updateTtfbTimeout = (value) => {
      const parsed = Number(value);
      state.ttfbTimeoutSeconds = clampTtfbTimeoutSeconds(parsed);
      state.ttfbTimeoutRaw = String(state.ttfbTimeoutSeconds);
      if (ttfbTimeoutInput) {
        ttfbTimeoutInput.value = state.ttfbTimeoutRaw;
      }
      persistTtfbTimeoutSetting(state.ttfbTimeoutSeconds);
    };

  return {
    isEnabled: () => state.enabled,
    isRunning: () => state.running,
    prepareFromInfo,
      prepareFromCache,
      refreshFromInfo,
      handlePrimaryAction,
      cancelDownload,
      pauseDownload,
      resumeDownload,
      reset,
      updateConnectionLimit,
      updateRetryLimit,
      updateParallelLimit,
      updateSegmentSize,
      updateTtfbTimeout,
      retryFailedSegments,
      clearStoredTasks,
    };
  })();

  const clientDecryptor = (() => {
    const state = {
      enabled: false,
      prepared: false,
      running: false,
      encryptionMode: 'plain',
      blockHeaderSize: 0,
      blockDataSize: 0,
      fileHeaderSize: 0,
      totalSize: 0,
      totalEncrypted: 0,
      dataKey: null,
      baseNonce: null,
      fileName: '',
      path: '',
      sourceFile: null,
      cancelRequested: false,
      decryptParallelism: DEFAULT_PARALLEL_THREADS,
      decryptParallelRaw: String(DEFAULT_PARALLEL_THREADS),
      segmentSizeMb: DEFAULT_SEGMENT_SIZE_MB,
      segmentSizeRaw: String(DEFAULT_SEGMENT_SIZE_MB),
      segments: [],
    };

    const reset = () => {
      state.enabled = false;
      state.prepared = false;
      state.running = false;
      state.encryptionMode = 'plain';
      state.blockHeaderSize = 0;
      state.blockDataSize = 0;
      state.fileHeaderSize = 0;
      state.totalSize = 0;
      state.totalEncrypted = 0;
      state.dataKey = null;
      state.baseNonce = null;
      state.fileName = '';
      state.path = '';
      state.sourceFile = null;
      state.cancelRequested = false;
      state.segments = [];
    };

    const prepareFromInfo = (info, ctx = {}) => {
      const normalized = normalizeDownloadInfo(info);
      if (!normalized.dataKey || normalized.dataKey.length === 0) {
        throw new Error('缺少 CRYPT_DATA_KEY，无法执行离线解密');
      }
      state.enabled = true;
      state.prepared = true;
      state.running = false;
      state.encryptionMode = normalized.encryptionMode;
      state.blockHeaderSize = Number(normalized.blockHeaderSize) || 0;
      state.blockDataSize = Number(normalized.blockDataSize) || 0;
      state.fileHeaderSize = Number(normalized.fileHeaderSize) || 0;
      state.totalSize = Number(normalized.totalSize) || 0;
      state.totalEncrypted = 0;
      state.dataKey = normalized.dataKey;
      state.baseNonce = null;
      state.fileName = normalized.fileName;
      state.path = typeof ctx.path === 'string' ? ctx.path : '';
      state.sourceFile = null;
      state.cancelRequested = false;
      state.segments = [];
    };

    const clampSegmentSizeValue = (value) =>
      clamp(Number(value), MIN_SEGMENT_SIZE_MB, MAX_SEGMENT_SIZE_MB, DEFAULT_SEGMENT_SIZE_MB);

    const clampParallelThreads = (value) => {
      if (!Number.isFinite(value)) {
        return DEFAULT_PARALLEL_THREADS;
      }
      const rounded = Math.floor(value);
      if (rounded < MIN_PARALLEL_THREADS) return MIN_PARALLEL_THREADS;
      if (rounded > MAX_PARALLEL_THREADS) return MAX_PARALLEL_THREADS;
      return rounded;
    };

    const resolveParallelism = (overrideValue) => {
      const configured = clampParallelThreads(
        Number.isFinite(overrideValue) ? overrideValue : state.decryptParallelism,
      );
      if (
        typeof navigator !== 'undefined' &&
        navigator &&
        Number.isFinite(navigator.hardwareConcurrency)
      ) {
        const hardwareClamped = clampParallelThreads(navigator.hardwareConcurrency);
        return Math.max(MIN_PARALLEL_THREADS, Math.min(configured, hardwareClamped));
      }
      return configured;
    };

    const updateParallelLimit = (value) => {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) {
        state.decryptParallelism = DEFAULT_PARALLEL_THREADS;
        state.decryptParallelRaw = String(DEFAULT_PARALLEL_THREADS);
        return state.decryptParallelism;
      }
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) {
        return state.decryptParallelism;
      }
      state.decryptParallelism = clampParallelThreads(parsed);
      state.decryptParallelRaw = String(state.decryptParallelism);
      return state.decryptParallelism;
    };

    const updateSegmentSize = (value) => {
      state.segmentSizeMb = clampSegmentSizeValue(value);
      state.segmentSizeRaw = String(state.segmentSizeMb);
      return state.segmentSizeMb;
    };

    const buildSegments = (segmentSizeMb) => {
      if (!Number.isFinite(state.totalSize) || state.totalSize <= 0) {
        throw new Error('文件大小未知，无法解密');
      }
      const meta = {
        encryption: state.encryptionMode,
        blockDataSize: state.blockDataSize,
        blockHeaderSize: state.blockHeaderSize,
        fileHeaderSize: state.fileHeaderSize,
      };
      const segmentSizeBytes = Math.round(clampSegmentSizeValue(segmentSizeMb) * BYTES_PER_MB);
      const segments = [];
      let offset = 0;
      let index = 0;
      let encryptedTotal = 0;
      while (offset < state.totalSize) {
        const length = Math.min(segmentSizeBytes, state.totalSize - offset);
        const mapping = calculateUnderlying(offset, length, meta);
        const encryptedSize = Number.isFinite(mapping.underlyingLimit) && mapping.underlyingLimit > 0
          ? mapping.underlyingLimit
          : length;
        encryptedTotal += encryptedSize;
        segments.push({
          index,
          offset,
          length,
          mapping,
        });
        offset += length;
        index += 1;
      }
      state.segments = segments;
      state.totalEncrypted = encryptedTotal > 0 ? encryptedTotal : state.totalSize;
      return segments;
    };

    const readEncryptedSegment = async (segment) => {
      if (!state.sourceFile) {
        throw new Error('缺少密文文件');
      }
      const mapping = segment.mapping || {};
      const start = Number(mapping.underlyingOffset) || 0;
      const limit = Number(mapping.underlyingLimit) || segment.length;
      const end = limit > 0 ? start + limit : start + segment.length;
      const slice = state.sourceFile.slice(start, end);
      const buffer = await slice.arrayBuffer();
      return new Uint8Array(buffer);
    };

    const ensureBaseNonceFromFile = async () => {
      if (state.encryptionMode !== 'crypt' || state.baseNonce) {
        return;
      }
      if (!state.sourceFile) {
        throw new Error('缺少密文文件');
      }
      if (!Number.isFinite(state.fileHeaderSize) || state.fileHeaderSize <= 0) {
        throw new Error('缺少 crypt header 尺寸配置');
      }
      const headerSlice = state.sourceFile.slice(0, state.fileHeaderSize);
      const headerBuffer = new Uint8Array(await headerSlice.arrayBuffer());
      state.baseNonce = extractCryptNonce(headerBuffer);
    };

    const start = async (options = {}) => {
      if (!state.prepared) {
        throw new Error('clientDecryptor 未准备就绪');
      }
      if (!state.sourceFile) {
        throw new Error('请先选择加密文件');
      }
      if (state.encryptionMode !== 'crypt') {
        throw new Error('该文件无需离线解密');
      }
      if (!state.dataKey || state.dataKey.length === 0) {
        throw new Error('缺少 CRYPT_DATA_KEY，无法解密');
      }
      const {
        segmentSizeMb = state.segmentSizeMb,
        parallelism: overrideParallel,
        onReadProgress,
        onDecryptProgress,
        writeChunk,
      } = options;
      if (typeof writeChunk !== 'function') {
        throw new Error('缺少写入处理函数');
      }
      const effectiveSegmentSize = updateSegmentSize(segmentSizeMb);
      const effectiveParallel = updateParallelLimit(
        Number.isFinite(overrideParallel) ? String(overrideParallel) : state.decryptParallelRaw,
      );
      const segments = buildSegments(effectiveSegmentSize);
      await ensureBaseNonceFromFile();
      const expectedEncryptedSize = state.totalEncrypted + (Number(state.fileHeaderSize) || 0);
      if (expectedEncryptedSize > 0 && Math.abs(state.sourceFile.size - expectedEncryptedSize) > state.blockHeaderSize + state.blockDataSize) {
        console.warn('密文文件大小与预期不完全一致', state.sourceFile.size, expectedEncryptedSize);
      }
      state.running = true;
      state.cancelRequested = false;
      let readBytes = 0;
      let decryptedBytes = 0;
      const totalSegments = segments.length;
      const parallelWorkers = Math.min(
        Math.max(1, resolveParallelism(effectiveParallel)),
        totalSegments || 1,
      );
      const commonParams = {
        dataKey: state.dataKey,
        baseNonce: state.baseNonce,
        blockHeaderSize: state.blockHeaderSize,
        blockDataSize: state.blockDataSize,
        encryptionMode: state.encryptionMode,
      };
      try {
        await runSegmentDecryptionTask({
          mode: 'clientDecrypt',
          segments,
          parallelism: parallelWorkers,
          commonParams,
          isCancelled: () => state.cancelRequested,
          getPayload: async (index) => {
            const segment = segments[index];
            const encrypted = await readEncryptedSegment(segment);
            readBytes = Math.min(state.totalEncrypted, readBytes + encrypted.length);
            if (typeof onReadProgress === 'function') {
              onReadProgress(readBytes, state.totalEncrypted);
            }
            return {
              length: segment.length,
              mapping: segment.mapping,
              encrypted,
            };
          },
          writeOrderedChunk: async (_index, chunk) => {
            if (state.cancelRequested) {
              throw new Error('解密已取消');
            }
            await writeChunk(chunk);
            decryptedBytes = Math.min(state.totalSize, decryptedBytes + chunk.length);
            if (typeof onDecryptProgress === 'function') {
              onDecryptProgress(decryptedBytes, state.totalSize);
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
          },
        });
      } finally {
        state.running = false;
        state.cancelRequested = false;
      }
    };

    const cancel = () => {
      state.cancelRequested = true;
    };

    return {
      prepareFromInfo,
      reset,
      setSourceFile: (file) => {
        state.sourceFile = file;
      },
      clearSourceFile: () => {
        state.sourceFile = null;
      },
      start,
      cancel,
      isRunning: () => state.running,
      isPrepared: () => state.prepared,
      hasFile: () => Boolean(state.sourceFile),
      getFileName: () => state.fileName,
      getTotalSize: () => state.totalSize,
      getEncryptedSize: () => state.totalEncrypted,
      updateParallelLimit,
      updateSegmentSize,
      getParallelism: () => state.decryptParallelism,
      getSegmentSizeMb: () => state.segmentSizeMb,
    };
  })();

  const clientDecryptUiState = state.clientDecrypt;

  const refreshClientDecryptSettingsState = () => {
    if (!clientDecryptUiState) return;
    const parallel = clientDecryptor.getParallelism();
    clientDecryptUiState.decryptParallelism = parallel;
    clientDecryptUiState.decryptParallelRaw = String(parallel);
    const segmentSize = clientDecryptor.getSegmentSizeMb();
    clientDecryptUiState.segmentSizeMb = segmentSize;
    clientDecryptUiState.segmentSizeRaw = String(segmentSize);
  };

  const syncClientDecryptorSettingsFromInputs = () => {
    if (parallelLimitInput) {
      clientDecryptor.updateParallelLimit(parallelLimitInput.value);
    }
    if (segmentSizeInput) {
      clientDecryptor.updateSegmentSize(segmentSizeInput.value);
    }
    refreshClientDecryptSettingsState();
  };

  syncClientDecryptorSettingsFromInputs();

  const formatProgressText = (value, total) => {
    if (!Number.isFinite(total) || total <= 0) {
      return '0%';
    }
    const percent = Math.min(100, (value / total) * 100);
    return percent.toFixed(2) + '%';
  };

  const updateClientReadProgress = (value, total) => {
    if (!downloadBar || !downloadText) return;
    const text = formatProgressText(value, total);
    downloadBar.style.width = text;
    downloadText.textContent = Number.isFinite(total) && total > 0
      ? text + ' (' + formatBytes(value) + ' / ' + formatBytes(total) + ')'
      : text;
  };

  const updateClientDecryptProgress = (value, total) => {
    const text = formatProgressText(value, total);
    // 更新 web-only 解密进度条
    if (decryptBar && decryptText) {
      decryptBar.style.width = text;
      decryptText.textContent = Number.isFinite(total) && total > 0
        ? text + ' (' + formatBytes(value) + ' / ' + formatBytes(total) + ')'
        : text;
    }
    // 更新离线解密模式的文件容器进度（通过 CSS 变量）
    if (clientDecryptFileNameEl && clientDecryptFileNameEl.parentElement) {
      clientDecryptFileNameEl.parentElement.style.setProperty('--decrypt-progress', text);
    }
  };

  const resetClientDecryptProgress = () => {
    if (downloadBar) downloadBar.style.width = '0%';
    if (downloadText) downloadText.textContent = '0%';
    if (decryptBar) decryptBar.style.width = '0%';
    if (decryptText) decryptText.textContent = '0%';
    // 重置离线解密模式的文件容器进度
    if (clientDecryptFileNameEl && clientDecryptFileNameEl.parentElement) {
      clientDecryptFileNameEl.parentElement.style.setProperty('--decrypt-progress', '0%');
    }
  };

  const getEncryptedDisplayName = (name) => {
    if (!clientDecryptUiState.isCrypt || !name) return name;
    return name.toLowerCase().endsWith('.enc') ? name : name + '.enc';
  };

  const updateClientDecryptStatusHint = (status) => {
    if (!clientDecryptStatusHint) return;
    // 移除所有状态类
    clientDecryptStatusHint.classList.remove('hint-warning', 'hint-success-complete', 'hint-error');
    // 根据状态设置类和文本
    if (status === 'pending') {
      clientDecryptStatusHint.classList.add('hint-warning');
      clientDecryptStatusHint.textContent = '需要本地解密';
    } else if (status === 'success') {
      clientDecryptStatusHint.classList.add('hint-success-complete');
      clientDecryptStatusHint.textContent = '本地解密已完成';
    } else if (status === 'error') {
      clientDecryptStatusHint.classList.add('hint-error');
      clientDecryptStatusHint.textContent = '本地解密失败';
    }
  };

  const syncClientDecryptFileInfo = () => {
    if (!clientDecryptFileNameEl || !clientDecryptFileSizeEl) return;
    if (clientDecryptUiState.file) {
      clientDecryptFileNameEl.textContent = clientDecryptUiState.file.name || clientDecryptUiState.fileName || '密文文件';
      clientDecryptFileSizeEl.textContent = formatBytes(clientDecryptUiState.file.size);
    } else if (clientDecryptUiState.fileName) {
      const displayName = getEncryptedDisplayName(clientDecryptUiState.fileName);
      clientDecryptFileNameEl.textContent = displayName;
      clientDecryptFileSizeEl.textContent = clientDecryptUiState.fileSize > 0
        ? formatBytes(clientDecryptUiState.fileSize)
        : '--';
    } else {
      clientDecryptFileNameEl.textContent = '尚未选择文件';
      clientDecryptFileSizeEl.textContent = '--';
    }
  };

    const setClientDecryptFile = (file) => {
    clientDecryptUiState.file = file || null;
    clientDecryptUiState.fileName = file ? file.name : clientDecryptUiState.fileName;
    clientDecryptUiState.fileSize = file ? file.size : clientDecryptUiState.fileSize;
    clientDecryptUiState.completed = false;
    clientDecryptUiState.failed = false;
    syncClientDecryptFileInfo();
  };

  const clearClientDecryptFile = () => {
    clientDecryptUiState.file = null;
    clientDecryptUiState.completed = false;
    clientDecryptUiState.failed = false;
    clientDecryptUiState.downloadInitiated = false;
    syncClientDecryptFileInfo();
    if (clientDecryptFileInput) {
      clientDecryptFileInput.value = '';
    }
    clientDecryptor.clearSourceFile();
  };

  const syncClientDecryptControls = () => {
    if (clientDecryptStartBtn) {
      let disabled =
        !clientDecryptUiState.enabled ||
        !clientDecryptUiState.ready ||
        !clientDecryptUiState.file ||
        clientDecryptUiState.running;
      let label = '开始解密';
      let loading = false;
      if (clientDecryptUiState.running) {
        label = '解密中';
        loading = true;
      } else if (clientDecryptUiState.failed) {
        label = '✗ 解密失败';
        disabled = false;
      } else if (clientDecryptUiState.completed) {
        label = '✓ 解密完成';
        disabled = true;
      }
      setButtonText(clientDecryptStartBtn, label, loading);
      clientDecryptStartBtn.disabled = disabled;
    }
    if (clientDecryptCancelBtn) {
      clientDecryptCancelBtn.hidden = !clientDecryptUiState.running;
    }
  };

  const triggerClientDecryptDownload = (url, { userGesture = false } = {}) => {
    if (!url || typeof url !== 'string') {
      return false;
    }
    try {
      const opened = window.open(url, '_blank', 'noopener,noreferrer');
      if (opened) {
        if (userGesture) {
          log('已在新标签页打开密文下载');
        } else {
          log('已尝试在新标签页打开密文下载，若浏览器拦截请点击“开始下载”按钮');
        }
        return true;
      }
    } catch (error) {
      console.warn('自动打开密文下载失败', error);
    }
    return false;
  };

  const initClientDecryptDropzone = () => {
    if (!clientDecryptSection || !clientDecryptSupported) {
      return;
    }
    const prevent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const activate = () => {
      clientDecryptSection.classList.add('is-dropping');
    };
    const deactivate = () => {
      clientDecryptSection.classList.remove('is-dropping');
    };
    ['dragenter', 'dragover'].forEach((type) => {
      clientDecryptSection.addEventListener(type, (event) => {
        prevent(event);
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy';
        }
        activate();
      });
    });
    clientDecryptSection.addEventListener('dragleave', (event) => {
      // Only deactivate if leaving the container entirely (not entering a child element)
      const rect = clientDecryptSection.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
        deactivate();
      }
    });
    clientDecryptSection.addEventListener('drop', (event) => {
      prevent(event);
      deactivate();
      const dropped = event.dataTransfer?.files;
      if (!dropped || dropped.length === 0) {
        return;
      }
      const file = dropped[0];
      if (file) {
        setClientDecryptFile(file);
        clientDecryptor.setSourceFile(file);
        syncClientDecryptControls();
        setStatus('已选择密文文件：' + (file.name || '')); // status log to inform user
      }
    });
  };

  let clientDecryptWriter = null;

  const acquireClientDecryptWriter = async (suggestedName) => {
    if (typeof window.showSaveFilePicker === 'function') {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: suggestedName || 'download.bin',
          types: [{ description: 'Binary file', accept: { 'application/octet-stream': ['.bin'] } }],
        });
        const writable = await handle.createWritable({ keepExistingData: false });
        clientDecryptWriter = { type: 'fs', handle, writable };
        return clientDecryptWriter;
      } catch (error) {
        throw error;
      }
    }
    clientDecryptWriter = { type: 'memory', chunks: [] };
    return clientDecryptWriter;
  };

  const writeClientDecryptChunk = async (writer, chunk) => {
    if (!writer) throw new Error('writer 未初始化');
    if (writer.type === 'fs') {
      await writer.writable.write(chunk);
      return;
    }
    writer.chunks.push(chunk);
  };

  const finalizeClientDecryptWriter = async (writer, fileName) => {
    if (!writer) return;
    if (writer.type === 'fs') {
      await writer.writable.close();
      clientDecryptWriter = null;
      return;
    }
    const blob = new Blob(writer.chunks, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName || 'download.bin';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    clientDecryptWriter = null;
  };

  const abortClientDecryptWriter = async (writer) => {
    if (writer && writer.type === 'fs' && writer.writable) {
      try {
        await writer.writable.abort();
      } catch (error) {
        console.warn('终止文件写入失败', error);
      }
    }
    clientDecryptWriter = null;
  };

  const updateButtonState = () => {
    if (!downloadBtn) return;
    if (state.infoReady) {
      return;
    }
    if (shouldEnforceTurnstile()) {
      const { valid, reason } = getTurnstileBindingStatus();
      if (!valid) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = reason === 'expired' ? '验证已过期' : '验证不可用';
        return;
      }
    }
    const {
      needAltcha,
      needTurnstile,
      altchaReady,
      turnstileReady,
    } = state.verification;
    const canCallInfo = (!needAltcha || altchaReady) && (!needTurnstile || turnstileReady);

    // 如果 /info 接口获取失败，显示获取失败状态
    if (state.infoError) {
      downloadBtn.disabled = true;
      setButtonText(downloadBtn, '获取失败', false);
      return;
    }

    // 如果正在获取 /info，显示获取信息中状态
    if (state.fetchingInfo) {
      downloadBtn.disabled = true;
      setButtonText(downloadBtn, '获取信息中', true);
      return;
    }

    if (canCallInfo) {
      downloadBtn.disabled = false;
      setButtonText(downloadBtn, '开始下载', false);
    } else {
      downloadBtn.disabled = true;
      setButtonText(downloadBtn, '身份验证中', true);
    }
  };

  const setTurnstileMessage = (text) => {
    if (!turnstileMessage) return;
    if (text) {
      turnstileMessage.textContent = text;
      turnstileMessage.hidden = false;
    } else {
      turnstileMessage.textContent = '';
      turnstileMessage.hidden = true;
    }
  };

  const showTurnstileContainer = () => {
    if (!turnstileContainer) return;
    turnstileContainer.hidden = false;
    turnstileContainer.classList.add('is-visible');
  };

  const hideTurnstileContainer = () => {
    if (!turnstileContainer) return;
    turnstileContainer.hidden = true;
    turnstileContainer.classList.remove('is-visible');
  };

  const shouldEnforceTurnstile = () => state.verification.needTurnstile === true;

  const getTurnstileBindingStatus = () => {
    const binding = state.security.turnstileBinding;
    if (!shouldEnforceTurnstile()) {
      return { valid: true, binding: null, reason: null };
    }
    if (!binding || typeof binding !== 'object') {
      return { valid: false, binding: null, reason: 'missing' };
    }
    const expiresAt = Number.isFinite(binding.bindingExpiresAt)
      ? binding.bindingExpiresAt
      : Number.parseInt(binding.bindingExpiresAt, 10);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return { valid: false, binding, reason: 'invalid' };
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (expiresAt <= nowSeconds) {
      return { valid: false, binding, reason: 'expired' };
    }
    const nonce = typeof binding.nonce === 'string' ? binding.nonce.replace(/=+$/u, '') : '';
    const cdata = typeof binding.cdata === 'string' ? binding.cdata.replace(/=+$/u, '') : '';
    if (!nonce || !cdata) {
      return { valid: false, binding, reason: 'invalid' };
    }
    return {
      valid: true,
      binding: { ...binding, bindingExpiresAt: expiresAt, nonce, cdata },
      reason: null,
    };
  };

  const ensureTurnstileBinding = () => {
    const status = getTurnstileBindingStatus();
    if (status.valid && status.binding) {
      return status.binding;
    }
    if (!status.valid) {
      if (status.reason === 'expired') {
        throw new Error('Turnstile 绑定已过期，请刷新页面后重试');
      }
      throw new Error('缺少 Turnstile 绑定信息，请刷新页面后重试');
    }
    return null;
  };

  const syncTurnstilePrompt = () => {
    if (!shouldEnforceTurnstile()) {
      hideTurnstileContainer();
      if (!state.verification.turnstileToken) {
        setTurnstileMessage('');
      }
      return;
    }
    showTurnstileContainer();
    const status = getTurnstileBindingStatus();
    if (!status.valid) {
      if (status.reason === 'expired') {
        setTurnstileMessage('验证已过期，请刷新页面');
      } else {
        setTurnstileMessage('验证信息缺失，请刷新页面');
      }
      return;
    }
    if (!state.verification.turnstileToken) {
      setTurnstileMessage('请完成验证后继续下载');
    }
  };

  const fulfilTurnstileResolvers = (token) => {
    const resolvers = state.verification.tokenResolvers.splice(0, state.verification.tokenResolvers.length);
    resolvers.forEach((resolver) => {
      try {
        resolver(token);
      } catch (error) {
        console.error('Turnstile resolver failed', error);
      }
    });
  };

  const clearTurnstileToken = () => {
    state.verification.turnstileToken = null;
    state.verification.turnstileIssuedAt = 0;
    state.verification.turnstileReady = false;
    updateButtonState();
  };

  const SECURITY_SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  const ALTCHA_MODULE_URL = 'https://cdn.jsdelivr.net/npm/altcha-lib@1.3.0/+esm';

  let altchaModulePromise = null;
  const loadAltchaModule = () => {
    if (!altchaModulePromise) {
      altchaModulePromise = import(ALTCHA_MODULE_URL);
    }
    return altchaModulePromise;
  };

  let altchaComputationPromise = null;
  const startAltchaComputation = () => {
    if (!state.verification.needAltcha) {
      state.verification.altchaReady = true;
      state.verification.altchaSolution = null;
      updateButtonState();
      return Promise.resolve(null);
    }
    if (state.verification.altchaReady && state.verification.altchaSolution) {
      return Promise.resolve(state.verification.altchaSolution);
    }
    if (altchaComputationPromise) {
      return altchaComputationPromise;
    }
    const challenge = state.security.altchaChallenge;
    if (!challenge) {
      state.verification.altchaReady = false;
      updateButtonState();
      return Promise.reject(new Error('缺少 ALTCHA 挑战'));
    }
    if (
      typeof challenge.binding !== 'string' ||
      challenge.binding.length === 0 ||
      typeof challenge.pathHash !== 'string' ||
      challenge.pathHash.length === 0 ||
      !Number.isFinite(challenge.bindingExpiresAt)
    ) {
      state.verification.altchaReady = false;
      updateButtonState();
      return Promise.reject(new Error('ALTCHA 挑战缺少绑定信息'));
    }

    const computePromise = (async () => {
      try {
        setStatus('正在进行身份验证（PoW 计算）...');
        const module = await loadAltchaModule();
        const { solveChallenge } = module || {};
        if (typeof solveChallenge !== 'function') {
          throw new Error('ALTCHA 求解函数不可用');
        }
        const { promise } = solveChallenge(
          challenge.challenge,
          challenge.salt,
          challenge.algorithm,
          challenge.maxnumber
        );
        const solutionResult = await promise;
        if (!solutionResult || typeof solutionResult.number !== 'number') {
          throw new Error('ALTCHA PoW 计算未返回有效结果');
        }
        const solution = {
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          number: solutionResult.number,
          salt: challenge.salt,
          signature: challenge.signature,
          pathHash: challenge.pathHash,
          ipHash: typeof challenge.ipHash === 'string' ? challenge.ipHash : '',
          binding: challenge.binding,
          bindingExpiresAt: challenge.bindingExpiresAt,
        };
        const secondsUntilExpiry = Math.max(
          0,
          Math.floor(challenge.bindingExpiresAt - Date.now() / 1000)
        );
        log('PoW计算完成，' + secondsUntilExpiry + '秒后失效');
        state.verification.altchaSolution = solution;
        state.verification.altchaIssuedAt = Date.now();
        state.verification.altchaReady = true;
        updateButtonState();
        return solution;
      } catch (error) {
        state.verification.altchaSolution = null;
        state.verification.altchaIssuedAt = 0;
        state.verification.altchaReady = false;
        updateButtonState();
        throw error;
      } finally {
        altchaComputationPromise = null;
      }
    })();

    altchaComputationPromise = computePromise;
    return computePromise;
  };

  const ensureTurnstileScript = () => {
    if (!shouldEnforceTurnstile()) return Promise.resolve();
    if (state.security.scriptLoaded) return Promise.resolve();
    if (state.security.scriptLoading) return state.security.scriptLoading;
    state.security.scriptLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SECURITY_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => {
        state.security.scriptLoaded = true;
        state.security.scriptLoading = null;
        resolve();
      };
      script.onerror = () => {
        state.security.scriptLoading = null;
        reject(new Error('Turnstile 脚本加载失败'));
      };
      document.head.appendChild(script);
    });
    return state.security.scriptLoading;
  };

  const renderTurnstileWidget = async () => {
    if (!shouldEnforceTurnstile()) {
      hideTurnstileContainer();
      setTurnstileMessage('');
      return;
    }
    await ensureTurnstileScript();
    if (!turnstileContainer) {
      throw new Error('缺少 Turnstile 容器');
    }
    if (!window.turnstile || typeof window.turnstile.render !== 'function') {
      throw new Error('Turnstile 未初始化');
    }
    showTurnstileContainer();
    if (state.security.widgetId !== null) {
      return;
    }
    const bindingStatus = getTurnstileBindingStatus();
    if (!bindingStatus.valid) {
      if (bindingStatus.reason === 'expired') {
        setTurnstileMessage('验证已过期，请刷新页面');
      } else {
        setTurnstileMessage('验证信息缺失，请刷新页面');
      }
      return;
    }
    const activeBinding = bindingStatus.binding;
    turnstileContainer.innerHTML = '';
    setTurnstileMessage('请完成验证后继续下载');
    state.security.widgetId = window.turnstile.render(turnstileContainer, {
      sitekey: state.security.siteKey,
      theme: 'dark',
      execution: 'render',
      action: state.security.turnstileAction || 'download',
      cData: activeBinding.cdata,
      callback: (token) => {
        state.verification.turnstileToken = token || '';
        state.verification.turnstileIssuedAt = Date.now();
        state.verification.turnstileReady = true;
        hideTurnstileContainer();
        setTurnstileMessage('');
        fulfilTurnstileResolvers(state.verification.turnstileToken);
        updateButtonState();
        if (state.awaitingRetryUnlock) {
          state.awaitingRetryUnlock = false;
          retryBtn.disabled = false;
        }
      },
      'expired-callback': () => {
        clearTurnstileToken();
        setTurnstileMessage('验证已过期，请重新验证');
      },
      'error-callback': () => {
        clearTurnstileToken();
        setTurnstileMessage('验证失败，请重试');
        if (typeof window.turnstile.reset === 'function' && state.security.widgetId !== null) {
          try {
            window.turnstile.reset(state.security.widgetId);
          } catch (error) {
            console.warn('Turnstile reset 失败', error);
          }
        }
      },
    });
  };

  const waitForTurnstileToken = async () => {
    if (!shouldEnforceTurnstile()) return '';
    if (!state.security.siteKey) {
      throw new Error('缺少 Turnstile site key');
    }
    await renderTurnstileWidget();
    if (!state.verification.turnstileToken) {
      showTurnstileContainer();
      setTurnstileMessage('请完成验证后继续下载');
    }
    if (state.verification.turnstileToken) {
      return state.verification.turnstileToken;
    }
    return new Promise((resolve) => {
      state.verification.tokenResolvers.push(resolve);
    });
  };

  const consumeTurnstileToken = () => {
    if (!shouldEnforceTurnstile()) return;
    clearTurnstileToken();
    if (typeof window.turnstile?.reset === 'function' && state.security.widgetId !== null) {
      try {
        window.turnstile.reset(state.security.widgetId);
      } catch (error) {
        console.warn('Turnstile reset 失败', error);
      }
    }
  };

  const applySecurityConfig = (security = {}) => {
    state.security.underAttack = security.underAttack === true;
    state.security.siteKey =
      typeof security.turnstileSiteKey === 'string' ? security.turnstileSiteKey.trim() : '';
    state.security.turnstileAction =
      typeof security.turnstileAction === 'string' && security.turnstileAction.trim().length > 0
        ? security.turnstileAction.trim()
        : 'download';
    state.security.altchaChallenge =
      security.altchaChallenge && typeof security.altchaChallenge === 'object'
        ? security.altchaChallenge
        : null;
    const rawTurnstileBinding =
      security.turnstileBinding && typeof security.turnstileBinding === 'object'
        ? security.turnstileBinding
        : null;
    if (rawTurnstileBinding) {
      const bindingExpiresAt =
        typeof rawTurnstileBinding.bindingExpiresAt === 'number'
          ? rawTurnstileBinding.bindingExpiresAt
          : typeof rawTurnstileBinding.bindingExpiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.bindingExpiresAt, 10)
            : typeof rawTurnstileBinding.expiresAt === 'number'
              ? rawTurnstileBinding.expiresAt
              : typeof rawTurnstileBinding.expiresAt === 'string'
                ? Number.parseInt(rawTurnstileBinding.expiresAt, 10)
                : 0;
      const bindingValue =
        typeof rawTurnstileBinding.binding === 'string'
          ? rawTurnstileBinding.binding
          : typeof rawTurnstileBinding.bindingMac === 'string'
            ? rawTurnstileBinding.bindingMac
            : '';
      const pathHash =
        typeof rawTurnstileBinding.pathHash === 'string' ? rawTurnstileBinding.pathHash : '';
      const ipHash =
        typeof rawTurnstileBinding.ipHash === 'string' ? rawTurnstileBinding.ipHash : '';
      const nonce =
        typeof rawTurnstileBinding.nonce === 'string'
          ? rawTurnstileBinding.nonce.replace(/=+$/u, '')
          : '';
      const cdata =
        typeof rawTurnstileBinding.cdata === 'string'
          ? rawTurnstileBinding.cdata.replace(/=+$/u, '')
          : '';
      if (bindingValue && bindingExpiresAt > 0 && pathHash && nonce && cdata) {
        state.security.turnstileBinding = {
          pathHash,
          ipHash,
          binding: bindingValue,
          bindingExpiresAt,
          nonce,
          cdata,
        };
      } else {
        state.security.turnstileBinding = null;
      }
    } else {
      state.security.turnstileBinding = null;
    }
    state.verification.needAltcha = !!state.security.altchaChallenge;
    state.verification.needTurnstile =
      state.security.underAttack && typeof state.security.siteKey === 'string' && state.security.siteKey.length > 0;
    if (!state.verification.needTurnstile) {
      state.security.underAttack = false;
    }
    state.verification.altchaSolution = null;
    state.verification.altchaIssuedAt = 0;
    state.verification.altchaReady = !state.verification.needAltcha;
    state.verification.turnstileToken = null;
    state.verification.turnstileIssuedAt = 0;
    state.verification.turnstileReady = !state.verification.needTurnstile;
    state.verification.tokenResolvers = [];
    syncTurnstilePrompt();
    updateButtonState();
    if (state.verification.needAltcha) {
      startAltchaComputation().catch((error) => {
        console.error('ALTCHA 初始化失败:', error && error.message ? error.message : error);
      });
    }
  };

  const securityConfig =
    typeof window !== 'undefined' && window.__ALIST_SECURITY__ && typeof window.__ALIST_SECURITY__ === 'object'
      ? window.__ALIST_SECURITY__
      : {};
  applySecurityConfig(securityConfig);

  const STORAGE_DB_NAME = 'alist-crypt-storage';
  const STORAGE_DB_VERSION = 2;
  const STORAGE_TABLE_INFO = 'infoCache';

  const openStorageDatabase = (() => {
    let promise = null;
    return () => {
      if (promise) return promise;
      promise = (async () => {
        if (typeof window === 'undefined' || !window.indexedDB || !window.Dexie) {
          console.warn('Dexie 或 IndexedDB 不可用，本地设置将无法保存');
          return null;
        }
        const DexieClass = window.Dexie;
        const db = new DexieClass(STORAGE_DB_NAME);
        db.version(1).stores({
          [STORAGE_TABLE_INFO]: '&key,timestamp',
        });
        db.version(STORAGE_DB_VERSION).stores({
          [STORAGE_TABLE_INFO]: '&key,timestamp',
        });
        return db;
      })();
      return promise;
    };
  })();

  const handleInfoError = (error, context) => {
    const rawMessage =
      (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
    const normalizedMessage = rawMessage.toLowerCase();
    if (normalizedMessage.includes('altcha')) {
      state.verification.altchaSolution = null;
      state.verification.altchaIssuedAt = 0;
      state.verification.altchaReady = false;
      if (state.verification.needAltcha) {
        startAltchaComputation().catch((altchaError) => {
          console.error('ALTCHA 重新计算失败:', altchaError && altchaError.message ? altchaError.message : altchaError);
        });
      }
    }
    const needsWidgetRefresh =
      normalizedMessage.includes('429') ||
      normalizedMessage.includes('461') ||
      normalizedMessage.includes('462') ||
      normalizedMessage.includes('463') ||
      normalizedMessage.includes('binding') ||
      normalizedMessage.includes('rate limit') ||
      normalizedMessage.includes('turnstile');

    const enforceTurnstile = shouldEnforceTurnstile();
    const requiresTurnstileReset = needsWidgetRefresh && enforceTurnstile;
    state.awaitingRetryUnlock = false;
    if (requiresTurnstileReset) {
      consumeTurnstileToken();
      syncTurnstilePrompt();
      state.awaitingRetryUnlock = true;
    }

    let errorPrefix = '';
    if (context === 'init') {
      errorPrefix = '初始化失败：';
    } else if (context === 'retry') {
      errorPrefix = '重新获取信息失败：';
    } else if (context === 'clearCache') {
      errorPrefix = '缓存已清理，但重新获取信息失败：';
    }
    setStatus(errorPrefix + rawMessage);

    if (normalizedMessage.includes('binding')) {
      state.security.turnstileBinding = null;
      syncTurnstilePrompt();
    }

    state.downloadBtnMode = 'download';
    state.infoReady = false;
    state.fetchingInfo = false;
    state.infoError = true;
    clientDecryptUiState.ready = false;
    clientDecryptUiState.running = false;
    clientDecryptUiState.completed = false;
    syncClientDecryptControls();

    // 使用 updateButtonState 来更新按钮状态
    // 但对于特殊情况（Turnstile 重置和 binding 过期）需要覆盖文本
    if (requiresTurnstileReset) {
      downloadBtn.textContent = '等待验证';
      downloadBtn.disabled = true;
    } else if (normalizedMessage.includes('binding')) {
      downloadBtn.textContent = '验证已过期';
      downloadBtn.disabled = true;
      retryBtn.disabled = true;
      state.awaitingRetryUnlock = true;
    } else {
      updateButtonState();
    }

    retryBtn.disabled = requiresTurnstileReset || normalizedMessage.includes('binding');
    clearCacheBtn.disabled = false;
  };

  const fetchInfo = async ({ forceRefresh = false } = {}) => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    const sign = url.searchParams.get('sign') || '';

    if (!sign) {
      throw new Error('缺少签名参数 (sign)');
    }

    if (state.mode === 'web') {
      webDownloader.reset();
    }
    state.mode = 'legacy';
    syncBodyModeClasses();
    state.infoReady = false;
    state.infoError = false;
    clientDecryptUiState.ready = false;
    clientDecryptUiState.running = false;
    syncClientDecryptControls();
    updateButtonState();

    let warmedFromCache = false;
    if (!forceRefresh) {
      try {
        const cached = await webDownloader.prepareFromCache({
          path,
          sign,
          autoStart: false,
        });
        if (cached) {
          warmedFromCache = true;
          state.mode = 'web';
          syncBodyModeClasses();
          state.infoReady = true;
          setStatus('已从缓存恢复下载任务，正在刷新最新信息...');
          notifyAutoRedirectForWeb();
        }
      } catch (cacheError) {
        console.warn('从缓存恢复 webDownloader 失败', cacheError);
        webDownloader.reset();
        state.mode = 'legacy';
        syncBodyModeClasses();
        state.infoReady = false;
      }
    }

    const altchaPromise = state.verification.needAltcha
      ? startAltchaComputation()
      : Promise.resolve(null);

    let turnstileBindingEncoded = '';
    let turnstileBindingExpiresAt = 0;
    if (shouldEnforceTurnstile()) {
      const binding = ensureTurnstileBinding();
      if (binding) {
        turnstileBindingExpiresAt = Number(binding.bindingExpiresAt) || 0;
        const sanitizedNonce = typeof binding.nonce === 'string' ? binding.nonce.replace(/=+$/u, '') : '';
        const sanitizedCData = typeof binding.cdata === 'string' ? binding.cdata.replace(/=+$/u, '') : '';
        const payload = {
          pathHash: binding.pathHash,
          ipHash: binding.ipHash,
          binding: binding.binding || '',
          bindingExpiresAt: binding.bindingExpiresAt,
          nonce: sanitizedNonce,
          cdata: sanitizedCData,
        };
        turnstileBindingEncoded = base64urlEncode(JSON.stringify(payload));
      }
    }

    let turnstileToken = '';
    if (shouldEnforceTurnstile()) {
      turnstileToken = await waitForTurnstileToken();
      if (turnstileBindingExpiresAt > 0) {
        const nowSeconds = Math.floor(Date.now() / 1000);
        if (nowSeconds >= turnstileBindingExpiresAt) {
          throw new Error('Turnstile 绑定已过期，请刷新页面后重试');
        }
      }
    }

    let altchaSolution = null;
    if (state.verification.needAltcha) {
      try {
        const solution = await altchaPromise;
        if (!solution || typeof solution !== 'object') {
          throw new Error('ALTCHA PoW 计算未返回有效结果');
        }
        altchaSolution = solution;
      } catch (error) {
        throw new Error('ALTCHA PoW 计算失败：' + (error && error.message ? error.message : String(error || '未知错误')));
      }
    }

    // 验证完成后，设置 fetchingInfo 标记，表示开始获取 /info 接口数据
    state.fetchingInfo = true;
    updateButtonState();

    const infoURL = new URL('/info', window.location.origin);
    infoURL.searchParams.set('path', path);
    infoURL.searchParams.set('sign', sign);
    if (altchaSolution) {
      const solutionJson = JSON.stringify(altchaSolution);
      const base64urlToken = base64urlEncode(solutionJson);
      infoURL.searchParams.set('altChallengeResult', base64urlToken);
    }

    const headers = new Headers();
    if (turnstileToken) {
      headers.set('cf-turnstile-response', turnstileToken);
    }
    if (turnstileBindingEncoded) {
      headers.set('x-turnstile-binding', turnstileBindingEncoded);
    }

    setStatus('正在获取下载信息...');
    const response = await fetch(infoURL.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      let errorMessage = '获取下载信息失败';
      try {
        const errorData = await response.json();
        errorMessage = errorData.message || errorMessage;
      } catch (e) {
        errorMessage = 'HTTP ' + response.status;
      }
      throw new Error(errorMessage);
    }

    const result = await response.json();
    if (result.code !== 200) {
      throw new Error(result.message || '获取下载信息失败');
    }

    const infoData = result.data;
    if (!infoData?.download) {
      throw new Error('服务器未返回下载信息');
    }

    const downloadURL = infoData.download.url;
    if (!downloadURL) {
      throw new Error('服务器未返回下载链接');
    }

    if (infoData.settings?.webDownloader) {
      const shouldAutoStart = false; // webDownloader requires an explicit user gesture
      await webDownloader.refreshFromInfo(infoData, {
        autoStart: shouldAutoStart,
        path,
        sign,
      });
      clientDecryptor.reset();
      clearClientDecryptFile();
      resetClientDecryptProgress();
      clientDecryptUiState.ready = false;
      clientDecryptUiState.running = false;
      syncClientDecryptControls();
      state.mode = 'web';
      syncBodyModeClasses();
      state.infoReady = true;
      state.fetchingInfo = false;
      notifyAutoRedirectForWeb();
      return;
    }

    if (webDownloader.isEnabled()) {
      webDownloader.reset();
    }

    if (infoData.settings?.clientDecrypt) {
      try {
        clientDecryptor.prepareFromInfo(infoData, { path, sign });
      } catch (prepareError) {
        throw new Error(prepareError && prepareError.message ? prepareError.message : '离线解密初始化失败');
      }
      clearClientDecryptFile();
      syncClientDecryptorSettingsFromInputs();
      clientDecryptUiState.enabled = true;
      clientDecryptUiState.ready = true;
      clientDecryptUiState.completed = false;
      clientDecryptUiState.downloadInitiated = false;
      clientDecryptUiState.isCrypt = infoData.meta?.isCrypt === true;
      clientDecryptUiState.fileName = infoData.meta?.fileName || clientDecryptor.getFileName() || '';
      clientDecryptUiState.fileSize = Number(infoData.meta?.size) || 0;
      refreshClientDecryptSettingsState();
      syncClientDecryptFileInfo();
      syncClientDecryptControls();
      // 只有在成功获取到解密配置后才显示本地解密框
      if (clientDecryptSection) {
        clientDecryptSection.hidden = false;
      }
      state.mode = 'client-decrypt';
      syncBodyModeClasses();
      state.infoReady = true;
      state.fetchingInfo = false;
      state.downloadURL = downloadURL;
      state.downloadBtnMode = 'download';
      downloadBtn.disabled = false;
      downloadBtn.textContent = '开始下载';
      retryBtn.disabled = false;
      clearCacheBtn.disabled = false;
      log('加密路径匹配，需要本地解密');
      setStatus('已获取下载信息，请使用外部下载器完成密文下载后回到此处解密');
      return;
    }

    state.mode = 'legacy';
    syncBodyModeClasses();
    state.infoReady = false;
    clientDecryptUiState.ready = false;
    clientDecryptUiState.running = false;
    clientDecryptUiState.completed = false;
    clientDecryptUiState.downloadInitiated = false;
    clientDecryptUiState.isCrypt = false;
    syncClientDecryptControls();

    state.downloadURL = downloadURL;
    state.infoReady = true;
    state.fetchingInfo = false;

    // Update page title to filename after verification
    try {
      const pathSegments = path.split('/').filter(Boolean);
      if (pathSegments.length > 0) {
        const fileName = decodeURIComponent(pathSegments[pathSegments.length - 1]);
        document.title = fileName;
      }
    } catch (e) {
      // Ignore title update errors
    }

    if (shouldEnforceTurnstile()) {
      consumeTurnstileToken();
    }
    if (state.verification.needAltcha) {
      state.verification.altchaReady = false;
      state.verification.altchaSolution = null;
      state.verification.altchaIssuedAt = 0;
    }

    downloadBtn.disabled = false;
    downloadBtn.textContent = '跳转下载';
    state.downloadBtnMode = 'download';
    retryBtn.disabled = false;
    clearCacheBtn.disabled = false;
    if (autoRedirectEnabled) {
      redirectToDownload();
      return;
    }
    setStatus('就绪，点击按钮跳转下载');
  };

  const retryDownload = async () => {
    try {
      const response = await fetch(window.location.href);
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const scriptNodes = Array.from(doc.querySelectorAll('script'));
      let newSecurityConfig = null;
      for (const node of scriptNodes) {
        const content = node.textContent || '';
        const match = content.match(/window\.__ALIST_SECURITY__\s*=\s*({.*?});/s);
        if (match && match[1]) {
          try {
            newSecurityConfig = JSON.parse(match[1]);
          } catch (parseError) {
            console.warn('解析新的安全配置失败', parseError);
          }
          break;
        }
      }
      if (newSecurityConfig) {
        window.__ALIST_SECURITY__ = newSecurityConfig;
        applySecurityConfig(newSecurityConfig);
        if (state.verification.needTurnstile && window.turnstile && typeof window.turnstile.reset === 'function' && state.security.widgetId !== null) {
          try {
            window.turnstile.reset(state.security.widgetId);
          } catch (resetError) {
            console.warn('Turnstile reset 失败', resetError);
          }
        }
      }
      state.infoReady = false;
      state.infoError = false;
      state.downloadURL = '';
      state.downloadBtnMode = 'download';
      updateButtonState();
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error('Retry failed:', error);
      const rawMessage =
        (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
      log('重试失败：' + rawMessage);
      throw error;
    }
  };

  const redirectToDownload = () => {
    if (!state.downloadURL) {
      setStatus('缺少下载地址，无法跳转。');
      return;
    }

    setStatus('正在跳转下载...');
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      window.location.href = state.downloadURL;
      // Change button to copy mode after redirect attempt
      state.downloadBtnMode = 'copy';
      downloadBtn.textContent = '复制链接';
    } catch (error) {
      console.error('跳转下载失败', error);
      setStatus('跳转下载失败：' + (error && error.message ? error.message : '未知错误'));
      state.downloadBtnMode = 'download';
      downloadBtn.disabled = false;
      downloadBtn.textContent = '跳转下载';
      retryBtn.disabled = false;
      clearCacheBtn.disabled = false;
    }
  };

  const startClientDecryptFlow = async () => {
    if (!clientDecryptUiState.enabled) {
      setStatus('当前环境未启用离线解密');
      return;
    }
    if (!clientDecryptUiState.ready) {
      setStatus('尚未获取解密信息，请先点击重试');
      return;
    }
    if (!clientDecryptUiState.file) {
      setStatus('请选择已下载的密文文件');
      return;
    }
    clientDecryptor.setSourceFile(clientDecryptUiState.file);
    if (!window.nacl || !window.nacl.secretbox || !window.nacl.secretbox.open) {
      setStatus('TweetNaCl 初始化失败，无法解密');
      return;
    }
    if (clientDecryptUiState.running) {
      return;
    }
    clientDecryptUiState.running = true;
    clientDecryptUiState.completed = false;
    clientDecryptUiState.failed = false;
    syncClientDecryptControls();
    try {
      resetClientDecryptProgress();
      setStatus('正在准备离线解密...');
      const writer = await acquireClientDecryptWriter(clientDecryptor.getFileName() || clientDecryptUiState.file.name);
      syncClientDecryptorSettingsFromInputs();
      await clientDecryptor.start({
        segmentSizeMb: clientDecryptor.getSegmentSizeMb(),
        parallelism: clientDecryptor.getParallelism(),
        onReadProgress: (value, total) => {
          if (state.mode === 'client-decrypt') {
            updateClientReadProgress(value, total);
          }
        },
        onDecryptProgress: (value, total) => {
          if (state.mode === 'client-decrypt') {
            updateClientDecryptProgress(value, total);
          }
        },
        writeChunk: async (chunk) => {
          await writeClientDecryptChunk(writer, chunk);
        },
      });
      await finalizeClientDecryptWriter(writer, clientDecryptor.getFileName() || clientDecryptUiState.file.name);
      clientDecryptUiState.completed = true;
      clientDecryptUiState.failed = false;
      syncClientDecryptControls();
      updateClientDecryptStatusHint('success');
      setStatus('解密完成，文件已保存');
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error || '未知错误');
      if (message.includes('取消')) {
        setStatus('解密已取消');
        clientDecryptUiState.failed = false;
        updateClientDecryptStatusHint('pending');
      } else {
        setStatus('解密失败：' + message);
        console.error(error);
        clientDecryptUiState.failed = true;
        updateClientDecryptStatusHint('error');
      }
      clientDecryptUiState.completed = false;
      if (clientDecryptWriter) {
        await abortClientDecryptWriter(clientDecryptWriter);
      }
    } finally {
      clientDecryptUiState.running = false;
      syncClientDecryptControls();
    }
  };

  const cancelClientDecryptFlow = async () => {
    if (!clientDecryptUiState.running) return;
    setStatus('正在取消解密...');
    clientDecryptor.cancel();
    if (clientDecryptWriter) {
      await abortClientDecryptWriter(clientDecryptWriter);
    }
  };

  downloadBtn.addEventListener('click', () => {
    if (!state.infoReady) return;

    if (state.mode === 'web' && webDownloader.isEnabled()) {
      webDownloader.handlePrimaryAction();
      return;
    }

    if (state.mode === 'client-decrypt') {
      if (state.downloadBtnMode === 'download') {
        const opened = triggerClientDecryptDownload(state.downloadURL, { userGesture: true });
        if (opened) {
          state.downloadBtnMode = 'copy';
          downloadBtn.textContent = '复制链接';
          clientDecryptUiState.downloadInitiated = true;
          return;
        }
        state.downloadBtnMode = 'copy';
        downloadBtn.textContent = '复制链接';
        copyToClipboard(state.downloadURL, downloadBtn);
        clientDecryptUiState.downloadInitiated = true;
        return;
      }
      copyToClipboard(state.downloadURL, downloadBtn);
      return;
    }

    if (state.downloadBtnMode === 'copy') {
      // Copy mode: copy the download URL to clipboard
      copyToClipboard(state.downloadURL, downloadBtn);
    } else {
      // Download mode: redirect to download
      redirectToDownload();
    }
  });

  if (clientDecryptSelectBtn && clientDecryptFileInput) {
    clientDecryptSelectBtn.addEventListener('click', () => {
      clientDecryptFileInput.click();
    });
    clientDecryptFileInput.addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) {
        setClientDecryptFile(file);
        clientDecryptor.setSourceFile(file);
        updateClientDecryptStatusHint('pending');
      } else {
        clearClientDecryptFile();
        clientDecryptor.clearSourceFile();
      }
      syncClientDecryptControls();
    });
  }

  if (clientDecryptStartBtn) {
    clientDecryptStartBtn.addEventListener('click', () => {
      startClientDecryptFlow().catch((error) => {
        console.error('离线解密失败', error);
      });
    });
  }

  if (clientDecryptCancelBtn) {
    clientDecryptCancelBtn.addEventListener('click', () => {
      cancelClientDecryptFlow().catch((error) => {
        console.warn('取消离线解密失败', error);
      });
    });
  }

  retryBtn.addEventListener('click', async () => {
    state.infoError = false;
    downloadBtn.disabled = true;
    setButtonText(downloadBtn, '身份验证中', true);
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    try {
      await retryDownload();
    } catch (error) {
      console.error(error);
      handleInfoError(error, 'retry');
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    if (state.mode === 'web') {
      webDownloader.reset();
    } else if (state.mode === 'client-decrypt') {
      clientDecryptor.reset();
      clearClientDecryptFile();
      clientDecryptUiState.ready = false;
      clientDecryptUiState.running = false;
      updateClientDecryptStatusHint('pending');
      syncClientDecryptControls();
      resetClientDecryptProgress();
    }
    clearCacheBtn.disabled = true;
    downloadBtn.disabled = true;
    retryBtn.disabled = true;
    setStatus('正在清理缓存...');
    state.infoReady = false;
    state.infoError = false;
    updateButtonState();
    let fetchAttempted = false;
    try {
      const db = await openStorageDatabase();
      if (db && db[STORAGE_TABLE_INFO]) {
        await db[STORAGE_TABLE_INFO].clear();
        log('缓存已清理');
      }
      setStatus('缓存已清理，正在重新获取信息...');
      fetchAttempted = true;
      await fetchInfo({ forceRefresh: true });
    } catch (error) {
      console.error(error);
      if (fetchAttempted) {
        handleInfoError(error, 'clearCache');
      } else {
        const rawMessage =
          (error && typeof error.message === 'string' && error.message) || String(error || '未知错误');
        setStatus('清理缓存失败：' + rawMessage);
        state.downloadBtnMode = 'download';
        downloadBtn.textContent = '跳转下载';
        downloadBtn.disabled = false;
        retryBtn.disabled = false;
        clearCacheBtn.disabled = false;
      }
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => {
      if (state.mode === 'client-decrypt') {
        cancelClientDecryptFlow().catch((error) => {
          if (error) {
            console.warn('取消离线解密失败', error);
          }
        });
        return;
      }
      webDownloader.cancelDownload().catch((error) => {
        if (error) {
          console.error('取消下载失败', error);
        }
      });
    });
  }

  if (clearEnvBtn) {
    clearEnvBtn.addEventListener('click', async () => {
      try {
        if (state.mode === 'client-decrypt') {
          clientDecryptor.reset();
          clearClientDecryptFile();
          clientDecryptUiState.ready = false;
          clientDecryptUiState.running = false;
          clientDecryptUiState.completed = false;
          updateClientDecryptStatusHint('pending');
          syncClientDecryptControls();
          resetClientDecryptProgress();
        } else {
          await webDownloader.clearStoredTasks();
        }
        state.infoReady = false;
        state.mode = clientDecryptSupported ? 'client-decrypt' : 'legacy';
        syncBodyModeClasses();
        state.downloadBtnMode = 'download';
        if (downloadBtn) {
          downloadBtn.textContent = '开始下载';
          downloadBtn.disabled = false;
        }
        updateButtonState();
      } catch (error) {
        console.error('清理任务失败', error);
        setStatus('清理任务失败：' + (error && error.message ? error.message : '未知错误'));
      }
    });
  }

  if (connectionLimitInput) {
    connectionLimitInput.addEventListener('change', (event) => {
      webDownloader.updateConnectionLimit(event.target.value);
    });
  }

  if (retryLimitInput) {
    retryLimitInput.addEventListener('change', (event) => {
      webDownloader.updateRetryLimit(event.target.value);
    });
  }

  if (parallelLimitInput) {
    parallelLimitInput.addEventListener('change', (event) => {
      webDownloader.updateParallelLimit(event.target.value);
      clientDecryptor.updateParallelLimit(event.target.value);
      refreshClientDecryptSettingsState();
    });
  }

  if (segmentSizeInput) {
    segmentSizeInput.addEventListener('change', (event) => {
      webDownloader.updateSegmentSize(event.target.value);
      clientDecryptor.updateSegmentSize(event.target.value);
      refreshClientDecryptSettingsState();
    });
  }

  if (ttfbTimeoutInput) {
    ttfbTimeoutInput.addEventListener('change', (event) => {
      webDownloader.updateTtfbTimeout(event.target.value);
    });
  }

  if (retryFailedSegmentsBtn) {
    retryFailedSegmentsBtn.addEventListener('click', () => {
      webDownloader.retryFailedSegments();
    });
  }

  const runKeygen = async () => {
    if (!keygenPasswordInput || !keygenOutputEl || !keygenStatusEl) return;
    const password = keygenPasswordInput.value.trim();
    if (!password) {
      keygenStatusEl.textContent = '请输入 password1';
      return;
    }
    if (keygenRunBtn) keygenRunBtn.disabled = true;
    keygenStatusEl.textContent = '';

    // 显示转圈动画
    if (keygenLoadingEl) {
      keygenLoadingEl.hidden = false;
    }

    try {
      const { scrypt } = await ensureScryptModule();
      const saltRaw = keygenSaltInput?.value || '';
      const saltBytes = saltRaw.trim() ? textEncoder.encode(saltRaw.trim()) : defaultKeygenSalt;
      const derived = await scrypt(textEncoder.encode(password), saltBytes, 16384, 8, 1, 80);
      const dataKey = derived.slice(0, 32);
      const nameKey = derived.slice(32, 64);
      const nameTweak = derived.slice(64, 80);
      const output = [
        'CRYPT_DATA_KEY=' + bytesToHex(dataKey),
        'CRYPT_NAME_KEY=' + bytesToHex(nameKey),
        'CRYPT_NAME_TWEAK=' + bytesToHex(nameTweak),
      ].join('\n');
      keygenOutputEl.textContent = output;
      keygenStatusEl.textContent = '完成';
    } catch (error) {
      console.error('keygen 失败', error);
      keygenStatusEl.textContent = '生成失败';
    } finally {
      if (keygenRunBtn) keygenRunBtn.disabled = false;
      // 隐藏转圈动画
      if (keygenLoadingEl) {
        keygenLoadingEl.hidden = true;
      }
    }
  };

  if (keygenRunBtn) {
    keygenRunBtn.addEventListener('click', runKeygen);
  }

  if (keygenCopyBtn && keygenOutputEl) {
    keygenCopyBtn.addEventListener('click', () => {
      const text = keygenOutputEl.textContent || '';
      if (!text) return;
      copyToClipboard(text, keygenCopyBtn);
    });
  }

  advancedToggleBtn.addEventListener('click', () => {
    if (advancedPanel.classList.contains('is-open')) {
      advancedPanel.classList.remove('is-open');
      advancedPanel.setAttribute('aria-hidden', 'true');
      advancedBackdrop.hidden = true;
    } else {
      advancedPanel.classList.add('is-open');
      advancedPanel.setAttribute('aria-hidden', 'false');
      advancedBackdrop.hidden = false;
    }
  });

  advancedCloseBtn.addEventListener('click', () => {
    advancedPanel.classList.remove('is-open');
    advancedPanel.setAttribute('aria-hidden', 'true');
    advancedBackdrop.hidden = true;
  });

  advancedBackdrop.addEventListener('click', () => {
    advancedPanel.classList.remove('is-open');
    advancedPanel.setAttribute('aria-hidden', 'true');
    advancedBackdrop.hidden = true;
  });

  syncClientDecryptFileInfo();
  syncClientDecryptControls();
  initClientDecryptDropzone();

  const initialise = async () => {
    state.infoReady = false;
    updateButtonState();
    retryBtn.disabled = true;
    clearCacheBtn.disabled = true;
    syncTurnstilePrompt();
    try {
      await fetchInfo({ forceRefresh: false });
    } catch (error) {
      console.error(error);
      handleInfoError(error, 'init');
    }
  };

  window.addEventListener('beforeunload', (event) => {
    const warnClientDecrypt =
      state.mode === 'client-decrypt' &&
      clientDecryptUiState.ready &&
      clientDecryptUiState.downloadInitiated &&
      !clientDecryptUiState.completed;
    if (warnClientDecrypt) {
      event.preventDefault();
      event.returnValue = '离线解密尚未完成，关闭页面会丢失进度';
    }
  });

  initialise();
})();
`;

const renderLandingPageHtml = (path, options = {}) => {
  const normalizedOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  // Extract filename from path (last segment after /)
  let display = '文件下载';
  if (path && path !== '/') {
    try {
      const decodedPath = decodeURIComponent(path);
      const segments = decodedPath.split('/').filter(Boolean);
      display = segments.length > 0 ? segments[segments.length - 1] : '文件下载';
    } catch (error) {
      display = '文件下载';
    }
  }
  const title = escapeHtml(display);
  const script = pageScript.replace(/<\/script>/g, '<\\/script>');
  const rawAltchaChallenge =
    normalizedOptions.altchaChallenge && typeof normalizedOptions.altchaChallenge === 'object'
      ? normalizedOptions.altchaChallenge
      : null;
  const normalizedAltchaChallenge = rawAltchaChallenge
    ? {
        algorithm: rawAltchaChallenge.algorithm,
        challenge: rawAltchaChallenge.challenge,
        salt: rawAltchaChallenge.salt,
        signature: rawAltchaChallenge.signature,
        maxnumber: rawAltchaChallenge.maxnumber,
        pathHash:
          typeof rawAltchaChallenge.pathHash === 'string' ? rawAltchaChallenge.pathHash : '',
        ipHash: typeof rawAltchaChallenge.ipHash === 'string' ? rawAltchaChallenge.ipHash : '',
        binding: typeof rawAltchaChallenge.binding === 'string' ? rawAltchaChallenge.binding : '',
        bindingExpiresAt:
          typeof rawAltchaChallenge.bindingExpiresAt === 'number'
            ? rawAltchaChallenge.bindingExpiresAt
            : typeof rawAltchaChallenge.bindingExpiresAt === 'string'
            ? Number.parseInt(rawAltchaChallenge.bindingExpiresAt, 10)
            : 0,
      }
    : null;
  const rawTurnstileBinding =
    normalizedOptions.turnstileBinding && typeof normalizedOptions.turnstileBinding === 'object'
      ? normalizedOptions.turnstileBinding
      : null;
  const normalizedTurnstileBinding = rawTurnstileBinding
    ? {
        pathHash:
          typeof rawTurnstileBinding.pathHash === 'string' ? rawTurnstileBinding.pathHash : '',
        ipHash: typeof rawTurnstileBinding.ipHash === 'string' ? rawTurnstileBinding.ipHash : '',
        binding:
          typeof rawTurnstileBinding.binding === 'string'
            ? rawTurnstileBinding.binding
            : typeof rawTurnstileBinding.bindingMac === 'string'
            ? rawTurnstileBinding.bindingMac
            : '',
        bindingExpiresAt:
          typeof rawTurnstileBinding.bindingExpiresAt === 'number'
            ? rawTurnstileBinding.bindingExpiresAt
            : typeof rawTurnstileBinding.bindingExpiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.bindingExpiresAt, 10)
            : typeof rawTurnstileBinding.expiresAt === 'number'
            ? rawTurnstileBinding.expiresAt
            : typeof rawTurnstileBinding.expiresAt === 'string'
            ? Number.parseInt(rawTurnstileBinding.expiresAt, 10)
            : 0,
        nonce:
          typeof rawTurnstileBinding.nonce === 'string' ? rawTurnstileBinding.nonce : '',
        cdata:
          typeof rawTurnstileBinding.cdata === 'string' ? rawTurnstileBinding.cdata : '',
      }
    : null;
  const turnstileAction =
    typeof normalizedOptions.turnstileAction === 'string' && normalizedOptions.turnstileAction.trim().length > 0
      ? normalizedOptions.turnstileAction.trim()
      : 'download';
  const securityConfig = {
    underAttack: normalizedOptions.underAttack === true,
    turnstileSiteKey:
      typeof normalizedOptions.turnstileSiteKey === 'string' ? normalizedOptions.turnstileSiteKey : '',
    turnstileAction,
    altchaChallenge: normalizedAltchaChallenge,
    turnstileBinding: normalizedTurnstileBinding,
  };
  const securityJson = JSON.stringify(securityConfig).replace(/</g, '\\u003c');
  const autoRedirectEnabled = normalizedOptions.autoRedirect === true;
  const autoRedirectLiteral = autoRedirectEnabled ? 'true' : 'false';
  const rawWebConfig =
    normalizedOptions.webDownloaderConfig && typeof normalizedOptions.webDownloaderConfig === 'object'
      ? normalizedOptions.webDownloaderConfig
      : null;
  const maxConnectionsValue = rawWebConfig && Number.isFinite(rawWebConfig.maxConnections)
    ? Number(rawWebConfig.maxConnections)
    : null;
  const normalizedWebDownloaderConfig = {
    maxConnections: Number.isFinite(maxConnectionsValue) ? maxConnectionsValue : null,
  };
  const webDownloaderPayload = {
    enabled: normalizedOptions.webDownloader === true,
    isCryptPath: normalizedOptions.isCryptPath === true,
    config: normalizedWebDownloaderConfig,
    clientDecrypt: normalizedOptions.clientDecrypt === true,
    decryptConfig:
      normalizedOptions.decryptConfig && typeof normalizedOptions.decryptConfig === 'object'
        ? normalizedOptions.decryptConfig
        : null,
  };
  const webDownloaderJson = JSON.stringify(webDownloaderPayload).replace(/</g, '\\u003c');

  // Use template and replace placeholders
  return htmlTemplate
    .replace(/\{\{TITLE\}\}/g, title)
    .replace(/\{\{STYLES\}\}/g, cssStyles)
    .replace(/\{\{SECURITY_JSON\}\}/g, securityJson)
    .replace(/\{\{AUTO_REDIRECT\}\}/g, autoRedirectLiteral)
    .replace(/\{\{WEB_DOWNLOADER_JSON\}\}/g, webDownloaderJson)
    .replace(/\{\{SCRIPT\}\}/g, script);
};

export const renderLandingPage = (path, options = {}) => {
  const normalizedOptions =
    options && typeof options === 'object' && !Array.isArray(options) ? options : {};
  const html = renderLandingPageHtml(path, normalizedOptions);
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': 'no-store',
    },
  });
};
