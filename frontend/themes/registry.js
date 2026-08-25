// Event-level character renderer registry. Unknown styles always fall back to LEGO.
(function () {
  const themes = new Map();
  window.PersonaFlowThemes = {
    register(styleId, definition) {
      themes.set(styleId, definition);
    },
    get(styleId) {
      return themes.get(styleId) || themes.get('lego') || null;
    },
  };
})();
