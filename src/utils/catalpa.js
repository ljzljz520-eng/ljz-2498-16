// 兼容层：旧的正则渲染器已被“文稿树解析 + 偏移感知渲染”取代。
// 新代码请直接使用 src/shared/parse.js 与 src/shared/render.js；
// 此文件仅保留 renderCatalpa(source) 这一旧入口的导出。
export { renderCatalpa } from '../shared/render.js'
