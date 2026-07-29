Page({
  data: {
    width: 0,
    height: 0,
    renderWidth: 0,
    renderHeight: 0,
  },

  onLoad(options) {
    // Wired through from pages/capture: the cloud-storage fileID of the photo
    // the user just uploaded. Phase 2 TODO: feed this into the generation
    // cloud function and load the resulting per-session GLB instead of the
    // bundled sample (swap point documented in components/xr-viewer). For now
    // it is only carried and logged so the plumbing is verifiable end-to-end.
    // Route params are NOT auto-decoded by the mini-program router, so undo
    // the encodeURIComponent applied in pages/capture before storing --
    // downstream (the future generation cloud function) needs the raw
    // "cloud://..." fileID.
    this.imageFileID = decodeURIComponent(
      (options && options.imageFileID) || ''
    );
    if (this.imageFileID) {
      console.log('[viewer] received imageFileID:', this.imageFileID);
    }

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
    // Phase 2 TODO: once a generated model is confirmed loaded, this is where
    // loading/progress UI would be dismissed.
  },

  onCaptureTap() {
    wx.navigateTo({ url: '/pages/capture/capture' });
  },

  onResetTap() {
    const viewer = this.selectComponent('#viewer');
    if (viewer) {
      viewer.reset();
    }
  },
});
