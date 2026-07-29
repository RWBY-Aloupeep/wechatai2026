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

  // Submit + poll flow against the generateModel cloud function. Hunyuan 3D
  // (rapid) takes ~1.5 min and cloud functions cap at 60s, so generation is
  // asynchronous: submit returns a jobId, then we poll `action: 'query'`
  // every POLL_INTERVAL_MS until done/failed/timeout. If the function has no
  // Tencent credentials configured it returns a stub modelFileID directly
  // from submit, which we handle as an immediate completion.
  _generate(imageFileID) {
    this.setData({ statusText: '提交生成任务…' });
    this._imageFileID = imageFileID;
    wx.cloud.callFunction({
      name: 'generateModel',
      data: { action: 'submit', imageFileID },
      success: (res) => {
        const result = res.result || {};
        if (result.ok && result.modelFileID) {
          this._finish(result.modelFileID);
          return;
        }
        if (result.ok && result.jobId) {
          this._pollCount = 0;
          this._poll(result.jobId);
          return;
        }
        console.error('[capture] submit returned error:', result);
        this._fail();
      },
      fail: (err) => {
        console.error('[capture] submit call failed:', err);
        this._fail();
      },
    });
  },

  _poll(jobId) {
    const POLL_INTERVAL_MS = 5000;
    const MAX_POLLS = 60; // ~5 minutes

    this._pollCount++;
    if (this._pollCount > MAX_POLLS) {
      console.error('[capture] generation timed out after', MAX_POLLS, 'polls');
      this._fail('生成超时，请重试');
      return;
    }
    this.setData({
      statusText: `生成中…约需 2 分钟（${this._pollCount * 5}s）`,
    });

    wx.cloud.callFunction({
      name: 'generateModel',
      data: { action: 'query', jobId },
      success: (res) => {
        const result = res.result || {};
        if (result.ok && result.status === 'done' && result.modelFileID) {
          this._finish(result.modelFileID);
          return;
        }
        if (result.ok && result.status === 'processing') {
          this._pollTimer = setTimeout(() => this._poll(jobId), POLL_INTERVAL_MS);
          return;
        }
        console.error('[capture] query returned error:', result);
        this._fail();
      },
      fail: (err) => {
        console.error('[capture] query call failed:', err);
        // Transient network failure -- keep polling rather than aborting.
        this._pollTimer = setTimeout(() => this._poll(jobId), POLL_INTERVAL_MS);
      },
    });
  },

  _finish(modelFileID) {
    this.setData({ uploading: false });
    wx.redirectTo({
      url:
        `/pages/viewer/viewer?modelFileID=${encodeURIComponent(modelFileID)}` +
        `&imageFileID=${encodeURIComponent(this._imageFileID || '')}`,
    });
  },

  _fail(message) {
    this.setData({ uploading: false });
    wx.showToast({ title: message || '生成失败，请重试', icon: 'none' });
  },

  onUnload() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
    }
  },
});
