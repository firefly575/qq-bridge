/* 记忆褪色面板的静态占位数据。
   真实部署时由插件 web api 提供（/api/plug/<插件名>/erosion_js），
   这里给一份空的，避免静态托管下 404；取不到有效 stats 时面板自动收起。 */
window.__FADE_DATA__ = {"ok": false, "stats": null, "items": [], "generated_at": ""};
