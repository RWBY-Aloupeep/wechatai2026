const DEFAULT_MODEL_SRC = '/assets/sample.glb';

Page({
  data: {
    width: 0,
    height: 0,
    renderWidth: 0,
    renderHeight: 0,
    // The xr-viewer component is only rendered (wx:if) once this is set --
    // either the bundled default or a resolved cloud temp URL. Deciding the
    // source BEFORE the scene exists avoids relying on xr-frame re-loading
    // an asset whose src changes after creation (unverified behavior).
    modelSrc: '',
  },

  onLoad(options) {
    // Route params are NOT auto-decoded by the mini-program router, so undo
    // the encodeURIComponent applied in pages/capture.
    this.imageFileID = decodeURIComponent(
      (options && options.imageFileID) || ''
    );
    const modelFileID = decodeURIComponent(
      (options && options.modelFileID) || ''
    );

    const info = wx.getWindowInfo();
    const pixelRatio = info.pixelRatio || 1;
    this.setData({
      width: info.windowWidth,
      height: info.windowHeight,
      renderWidth: Math.round(info.windowWidth * pixelRatio),
      renderHeight: Math.round(info.windowHeight * pixelRatio),
    });

    if (modelFileID) {
      // A generated model (currently the stub's placeholder GLB): xr-frame
      // loads assets over HTTPS, so convert the cloud fileID to a temporary
      // download URL first. NOTE for production release: the storage temp-URL
      // domain (*.tcb.qcloud.la) must be added to the mini program's
      // downloadFile 合法域名 whitelist; in DevTools/preview it works with
      // "不校验合法域名" checked.
      wx.cloud.getTempFileURL({
        fileList: [{ fileID: modelFileID, maxAge: 3600 }],
        success: (res) => {
          const item = res.fileList && res.fileList[0];
          if (item && item.tempFileURL) {
            console.log('[viewer] loading generated model:', item.tempFileURL);
            this.setData({ modelSrc: item.tempFileURL });
          } else {
            console.error('[viewer] getTempFileURL returned no URL:', res);
            wx.showToast({ title: '模型加载失败，显示示例模型', icon: 'none' });
            this.setData({ modelSrc: DEFAULT_MODEL_SRC });
          }
        },
        fail: (err) => {
          console.error('[viewer] getTempFileURL failed:', err);
          wx.showToast({ title: '模型加载失败，显示示例模型', icon: 'none' });
          this.setData({ modelSrc: DEFAULT_MODEL_SRC });
        },
      });
    } else {
      this.setData({ modelSrc: DEFAULT_MODEL_SRC });
    }
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
