Page({
  data: {
    width: 0,
    height: 0,
    renderWidth: 0,
    renderHeight: 0,
  },

  onLoad() {
    const info = wx.getWindowInfo();
    const pixelRatio = info.pixelRatio || 1;
    this.setData({
      width: info.windowWidth,
      height: info.windowHeight,
      renderWidth: Math.round(info.windowWidth * pixelRatio),
      renderHeight: Math.round(info.windowHeight * pixelRatio),
    });
  },

  onModelReady() {
    // Phase 2 TODO: once the model is confirmed loaded, this is where a
    // capture/upload entry button would be enabled/shown.
  },

  onResetTap() {
    const viewer = this.selectComponent('#viewer');
    if (viewer) {
      viewer.reset();
    }
  },
});
