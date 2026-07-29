Page({
  data: {
    tempFilePath: '',
    uploading: false,
    statusText: '',
  },

  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        this.setData({ tempFilePath: res.tempFiles[0].tempFilePath });
      },
    });
  },

  onUpload() {
    if (!this.data.tempFilePath || this.data.uploading) {
      return;
    }
    this.setData({ uploading: true, statusText: '上传中…' });

    const cloudPath = `captures/${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`;
    wx.cloud.uploadFile({
      cloudPath,
      filePath: this.data.tempFilePath,
      success: (res) => {
        this._generate(res.fileID);
      },
      fail: (err) => {
        console.error('[capture] upload failed:', err);
        wx.showToast({ title: '上传失败，请重试', icon: 'none' });
        this.setData({ uploading: false });
      },
    });
  },

  // Calls the generateModel cloud function (currently a stub returning a
  // placeholder GLB -- see cloudfunctions/generateModel/index.js). When real
  // Hunyuan 3D generation lands, generation may take ~1.5 min; this single
  // await-style call may then need to become submit + poll, but the client
  // contract (ends with a modelFileID to hand to the viewer) stays the same.
  _generate(imageFileID) {
    this.setData({ statusText: '生成中…' });
    wx.cloud.callFunction({
      name: 'generateModel',
      data: { imageFileID },
      success: (res) => {
        const result = res.result || {};
        if (!result.ok || !result.modelFileID) {
          console.error('[capture] generateModel returned error:', result);
          wx.showToast({ title: '生成失败，请重试', icon: 'none' });
          return;
        }
        wx.redirectTo({
          url:
            `/pages/viewer/viewer?modelFileID=${encodeURIComponent(result.modelFileID)}` +
            `&imageFileID=${encodeURIComponent(imageFileID)}`,
        });
      },
      fail: (err) => {
        console.error('[capture] generateModel call failed:', err);
        wx.showToast({ title: '生成失败，请重试', icon: 'none' });
      },
      complete: () => {
        this.setData({ uploading: false });
      },
    });
  },
});
