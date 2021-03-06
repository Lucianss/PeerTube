// FIXME: something weird with our path definition in tsconfig and typings
// @ts-ignore
import * as videojs from 'video.js'

import * as WebTorrent from 'webtorrent'
import { VideoFile } from '../../../../shared/models/videos/video.model'
import { renderVideo } from './video-renderer'
import './settings-menu-button'
import { PeertubePluginOptions, UserWatching, VideoJSCaption, VideoJSComponentInterface, videojsUntyped } from './peertube-videojs-typings'
import { isMobile, timeToInt, videoFileMaxByResolution, videoFileMinByResolution } from './utils'
import { PeertubeChunkStore } from './peertube-chunk-store'
import {
  getAverageBandwidthInStore,
  getStoredLastSubtitle,
  getStoredMute,
  getStoredVolume,
  getStoredWebTorrentEnabled,
  saveAverageBandwidth,
  saveLastSubtitle,
  saveMuteInStore,
  saveVolumeInStore
} from './peertube-player-local-storage'

const CacheChunkStore = require('cache-chunk-store')

type PlayOptions = {
  forcePlay?: boolean,
  seek?: number,
  delay?: number
}

const Plugin: VideoJSComponentInterface = videojs.getPlugin('plugin')
class PeerTubePlugin extends Plugin {
  private readonly playerElement: HTMLVideoElement

  private readonly autoplay: boolean = false
  private readonly startTime: number = 0
  private readonly savePlayerSrcFunction: Function
  private readonly videoFiles: VideoFile[]
  private readonly videoViewUrl: string
  private readonly videoDuration: number
  private readonly CONSTANTS = {
    INFO_SCHEDULER: 1000, // Don't change this
    AUTO_QUALITY_SCHEDULER: 3000, // Check quality every 3 seconds
    AUTO_QUALITY_THRESHOLD_PERCENT: 30, // Bandwidth should be 30% more important than a resolution bitrate to change to it
    AUTO_QUALITY_OBSERVATION_TIME: 10000, // Wait 10 seconds after having change the resolution before another check
    AUTO_QUALITY_HIGHER_RESOLUTION_DELAY: 5000, // Buffering higher resolution during 5 seconds
    BANDWIDTH_AVERAGE_NUMBER_OF_VALUES: 5, // Last 5 seconds to build average bandwidth
    USER_WATCHING_VIDEO_INTERVAL: 5000 // Every 5 seconds, notify the user is watching the video
  }

  private readonly webtorrent = new WebTorrent({
    tracker: {
      rtcConfig: {
        iceServers: [
          {
            urls: 'stun:stun.stunprotocol.org'
          },
          {
            urls: 'stun:stun.framasoft.org'
          }
        ]
      }
    },
    dht: false
  })

  private player: any
  private currentVideoFile: VideoFile
  private torrent: WebTorrent.Torrent
  private videoCaptions: VideoJSCaption[]
  private defaultSubtitle: string

  private renderer: any
  private fakeRenderer: any
  private destroyingFakeRenderer = false

  private autoResolution = true
  private forbidAutoResolution = false
  private isAutoResolutionObservation = false
  private playerRefusedP2P = false

  private videoViewInterval: any
  private torrentInfoInterval: any
  private autoQualityInterval: any
  private userWatchingVideoInterval: any
  private addTorrentDelay: any
  private qualityObservationTimer: any
  private runAutoQualitySchedulerTimer: any

  private downloadSpeeds: number[] = []

  constructor (player: videojs.Player, options: PeertubePluginOptions) {
    super(player, options)

    // Disable auto play on iOS
    this.autoplay = options.autoplay && this.isIOS() === false
    this.playerRefusedP2P = !getStoredWebTorrentEnabled()

    this.startTime = timeToInt(options.startTime)
    this.videoFiles = options.videoFiles
    this.videoViewUrl = options.videoViewUrl
    this.videoDuration = options.videoDuration
    this.videoCaptions = options.videoCaptions

    this.savePlayerSrcFunction = this.player.src
    this.playerElement = options.playerElement

    if (this.autoplay === true) this.player.addClass('vjs-has-autoplay')

    this.player.ready(() => {
      const playerOptions = this.player.options_

      const volume = getStoredVolume()
      if (volume !== undefined) this.player.volume(volume)

      const muted = playerOptions.muted !== undefined ? playerOptions.muted : getStoredMute()
      if (muted !== undefined) this.player.muted(muted)

      this.defaultSubtitle = options.subtitle || getStoredLastSubtitle()

      this.player.on('volumechange', () => {
        saveVolumeInStore(this.player.volume())
        saveMuteInStore(this.player.muted())
      })

      this.player.textTracks().on('change', () => {
        const showing = this.player.textTracks().tracks_.find((t: { kind: string, mode: string }) => {
          return t.kind === 'captions' && t.mode === 'showing'
        })

        if (!showing) {
          saveLastSubtitle('off')
          return
        }

        saveLastSubtitle(showing.language)
      })

      this.player.duration(options.videoDuration)

      this.initializePlayer()
      this.runTorrentInfoScheduler()
      this.runViewAdd()

      if (options.userWatching) this.runUserWatchVideo(options.userWatching)

      this.player.one('play', () => {
        // Don't run immediately scheduler, wait some seconds the TCP connections are made
        this.runAutoQualitySchedulerTimer = setTimeout(() => this.runAutoQualityScheduler(), this.CONSTANTS.AUTO_QUALITY_SCHEDULER)
      })
    })
  }

  dispose () {
    clearTimeout(this.addTorrentDelay)
    clearTimeout(this.qualityObservationTimer)
    clearTimeout(this.runAutoQualitySchedulerTimer)

    clearInterval(this.videoViewInterval)
    clearInterval(this.torrentInfoInterval)
    clearInterval(this.autoQualityInterval)

    if (this.userWatchingVideoInterval) clearInterval(this.userWatchingVideoInterval)

    // Don't need to destroy renderer, video player will be destroyed
    this.flushVideoFile(this.currentVideoFile, false)

    this.destroyFakeRenderer()
  }

  getCurrentResolutionId () {
    return this.currentVideoFile ? this.currentVideoFile.resolution.id : -1
  }

  getCurrentResolutionLabel () {
    if (!this.currentVideoFile) return ''

    const fps = this.currentVideoFile.fps >= 50 ? this.currentVideoFile.fps : ''
    return this.currentVideoFile.resolution.label + fps
  }

  updateVideoFile (
    videoFile?: VideoFile,
    options: {
      forcePlay?: boolean,
      seek?: number,
      delay?: number
    } = {},
    done: () => void = () => { /* empty */ }
  ) {
    // Automatically choose the adapted video file
    if (videoFile === undefined) {
      const savedAverageBandwidth = getAverageBandwidthInStore()
      videoFile = savedAverageBandwidth
        ? this.getAppropriateFile(savedAverageBandwidth)
        : this.pickAverageVideoFile()
    }

    // Don't add the same video file once again
    if (this.currentVideoFile !== undefined && this.currentVideoFile.magnetUri === videoFile.magnetUri) {
      return
    }

    // Do not display error to user because we will have multiple fallback
    this.disableErrorDisplay()

    // Hack to "simulate" src link in video.js >= 6
    // Without this, we can't play the video after pausing it
    // https://github.com/videojs/video.js/blob/master/src/js/player.js#L1633
    this.player.src = () => true
    const oldPlaybackRate = this.player.playbackRate()

    const previousVideoFile = this.currentVideoFile
    this.currentVideoFile = videoFile

    // Don't try on iOS that does not support MediaSource
    // Or don't use P2P if webtorrent is disabled
    if (this.isIOS() || this.playerRefusedP2P) {
      return this.fallbackToHttp(options, () => {
        this.player.playbackRate(oldPlaybackRate)
        return done()
      })
    }

    this.addTorrent(this.currentVideoFile.magnetUri, previousVideoFile, options, () => {
      this.player.playbackRate(oldPlaybackRate)
      return done()
    })

    this.trigger('videoFileUpdate')
  }

  updateResolution (resolutionId: number, delay = 0) {
    // Remember player state
    const currentTime = this.player.currentTime()
    const isPaused = this.player.paused()

    // Remove poster to have black background
    this.playerElement.poster = ''

    // Hide bigPlayButton
    if (!isPaused) {
      this.player.bigPlayButton.hide()
    }

    const newVideoFile = this.videoFiles.find(f => f.resolution.id === resolutionId)
    const options = {
      forcePlay: false,
      delay,
      seek: currentTime + (delay / 1000)
    }
    this.updateVideoFile(newVideoFile, options)
  }

  flushVideoFile (videoFile: VideoFile, destroyRenderer = true) {
    if (videoFile !== undefined && this.webtorrent.get(videoFile.magnetUri)) {
      if (destroyRenderer === true && this.renderer && this.renderer.destroy) this.renderer.destroy()

      this.webtorrent.remove(videoFile.magnetUri)
      console.log('Removed ' + videoFile.magnetUri)
    }
  }

  isAutoResolutionOn () {
    return this.autoResolution
  }

  enableAutoResolution () {
    this.autoResolution = true
    this.trigger('autoResolutionUpdate')
  }

  disableAutoResolution (forbid = false) {
    if (forbid === true) this.forbidAutoResolution = true

    this.autoResolution = false
    this.trigger('autoResolutionUpdate')
  }

  isAutoResolutionForbidden () {
    return this.forbidAutoResolution === true
  }

  getCurrentVideoFile () {
    return this.currentVideoFile
  }

  getTorrent () {
    return this.torrent
  }

  private addTorrent (
    magnetOrTorrentUrl: string,
    previousVideoFile: VideoFile,
    options: PlayOptions,
    done: Function
  ) {
    console.log('Adding ' + magnetOrTorrentUrl + '.')

    const oldTorrent = this.torrent
    const torrentOptions = {
      store: (chunkLength: number, storeOpts: any) => new CacheChunkStore(new PeertubeChunkStore(chunkLength, storeOpts), {
        max: 100
      })
    }

    this.torrent = this.webtorrent.add(magnetOrTorrentUrl, torrentOptions, torrent => {
      console.log('Added ' + magnetOrTorrentUrl + '.')

      if (oldTorrent) {
        // Pause the old torrent
        this.stopTorrent(oldTorrent)

        // We use a fake renderer so we download correct pieces of the next file
        if (options.delay) this.renderFileInFakeElement(torrent.files[ 0 ], options.delay)
      }

      // Render the video in a few seconds? (on resolution change for example, we wait some seconds of the new video resolution)
      this.addTorrentDelay = setTimeout(() => {
        // We don't need the fake renderer anymore
        this.destroyFakeRenderer()

        const paused = this.player.paused()

        this.flushVideoFile(previousVideoFile)

        // Update progress bar (just for the UI), do not wait rendering
        if (options.seek) this.player.currentTime(options.seek)

        const renderVideoOptions = { autoplay: false, controls: true }
        renderVideo(torrent.files[ 0 ], this.playerElement, renderVideoOptions, (err, renderer) => {
          this.renderer = renderer

          if (err) return this.fallbackToHttp(options, done)

          return this.tryToPlay(err => {
            if (err) return done(err)

            if (options.seek) this.seek(options.seek)
            if (options.forcePlay === false && paused === true) this.player.pause()

            return done()
          })
        })
      }, options.delay || 0)
    })

    this.torrent.on('error', (err: any) => console.error(err))

    this.torrent.on('warning', (err: any) => {
      // We don't support HTTP tracker but we don't care -> we use the web socket tracker
      if (err.message.indexOf('Unsupported tracker protocol') !== -1) return

      // Users don't care about issues with WebRTC, but developers do so log it in the console
      if (err.message.indexOf('Ice connection failed') !== -1) {
        console.log(err)
        return
      }

      // Magnet hash is not up to date with the torrent file, add directly the torrent file
      if (err.message.indexOf('incorrect info hash') !== -1) {
        console.error('Incorrect info hash detected, falling back to torrent file.')
        const newOptions = { forcePlay: true, seek: options.seek }
        return this.addTorrent(this.torrent[ 'xs' ], previousVideoFile, newOptions, done)
      }

      // Remote instance is down
      if (err.message.indexOf('from xs param') !== -1) {
        this.handleError(err)
      }

      console.warn(err)
    })
  }

  private tryToPlay (done?: (err?: Error) => void) {
    if (!done) done = function () { /* empty */ }

    const playPromise = this.player.play()
    if (playPromise !== undefined) {
      return playPromise.then(done)
                        .catch((err: Error) => {
                          if (err.message.indexOf('The play() request was interrupted by a call to pause()') !== -1) {
                            return
                          }

                          console.error(err)
                          this.player.pause()
                          this.player.posterImage.show()
                          this.player.removeClass('vjs-has-autoplay')
                          this.player.removeClass('vjs-has-big-play-button-clicked')

                          return done()
                        })
    }

    return done()
  }

  private seek (time: number) {
    this.player.currentTime(time)
    this.player.handleTechSeeked_()
  }

  private getAppropriateFile (averageDownloadSpeed?: number): VideoFile {
    if (this.videoFiles === undefined || this.videoFiles.length === 0) return undefined
    if (this.videoFiles.length === 1) return this.videoFiles[0]

    // Don't change the torrent is the play was ended
    if (this.torrent && this.torrent.progress === 1 && this.player.ended()) return this.currentVideoFile

    if (!averageDownloadSpeed) averageDownloadSpeed = this.getAndSaveActualDownloadSpeed()

    // Limit resolution according to player height
    const playerHeight = this.playerElement.offsetHeight as number

    // We take the first resolution just above the player height
    // Example: player height is 530px, we want the 720p file instead of 480p
    let maxResolution = this.videoFiles[0].resolution.id
    for (let i = this.videoFiles.length - 1; i >= 0; i--) {
      const resolutionId = this.videoFiles[i].resolution.id
      if (resolutionId >= playerHeight) {
        maxResolution = resolutionId
        break
      }
    }

    // Filter videos we can play according to our screen resolution and bandwidth
    const filteredFiles = this.videoFiles
                              .filter(f => f.resolution.id <= maxResolution)
                              .filter(f => {
                                const fileBitrate = (f.size / this.videoDuration)
                                let threshold = fileBitrate

                                // If this is for a higher resolution or an initial load: add a margin
                                if (!this.currentVideoFile || f.resolution.id > this.currentVideoFile.resolution.id) {
                                  threshold += ((fileBitrate * this.CONSTANTS.AUTO_QUALITY_THRESHOLD_PERCENT) / 100)
                                }

                                return averageDownloadSpeed > threshold
                              })

    // If the download speed is too bad, return the lowest resolution we have
    if (filteredFiles.length === 0) return videoFileMinByResolution(this.videoFiles)

    return videoFileMaxByResolution(filteredFiles)
  }

  private getAndSaveActualDownloadSpeed () {
    const start = Math.max(this.downloadSpeeds.length - this.CONSTANTS.BANDWIDTH_AVERAGE_NUMBER_OF_VALUES, 0)
    const lastDownloadSpeeds = this.downloadSpeeds.slice(start, this.downloadSpeeds.length)
    if (lastDownloadSpeeds.length === 0) return -1

    const sum = lastDownloadSpeeds.reduce((a, b) => a + b)
    const averageBandwidth = Math.round(sum / lastDownloadSpeeds.length)

    // Save the average bandwidth for future use
    saveAverageBandwidth(averageBandwidth)

    return averageBandwidth
  }

  private initializePlayer () {
    if (isMobile()) this.player.addClass('vjs-is-mobile')

    this.initSmoothProgressBar()

    this.initCaptions()

    this.alterInactivity()

    if (this.autoplay === true) {
      this.player.posterImage.hide()

      return this.updateVideoFile(undefined, { forcePlay: true, seek: this.startTime })
    }

    // Proxy first play
    const oldPlay = this.player.play.bind(this.player)
    this.player.play = () => {
      this.player.addClass('vjs-has-big-play-button-clicked')
      this.player.play = oldPlay

      this.updateVideoFile(undefined, { forcePlay: true, seek: this.startTime })
    }
  }

  private runAutoQualityScheduler () {
    this.autoQualityInterval = setInterval(() => {

      // Not initialized or in HTTP fallback
      if (this.torrent === undefined || this.torrent === null) return
      if (this.isAutoResolutionOn() === false) return
      if (this.isAutoResolutionObservation === true) return

      const file = this.getAppropriateFile()
      let changeResolution = false
      let changeResolutionDelay = 0

      // Lower resolution
      if (this.isPlayerWaiting() && file.resolution.id < this.currentVideoFile.resolution.id) {
        console.log('Downgrading automatically the resolution to: %s', file.resolution.label)
        changeResolution = true
      } else if (file.resolution.id > this.currentVideoFile.resolution.id) { // Higher resolution
        console.log('Upgrading automatically the resolution to: %s', file.resolution.label)
        changeResolution = true
        changeResolutionDelay = this.CONSTANTS.AUTO_QUALITY_HIGHER_RESOLUTION_DELAY
      }

      if (changeResolution === true) {
        this.updateResolution(file.resolution.id, changeResolutionDelay)

        // Wait some seconds in observation of our new resolution
        this.isAutoResolutionObservation = true

        this.qualityObservationTimer = setTimeout(() => {
          this.isAutoResolutionObservation = false
        }, this.CONSTANTS.AUTO_QUALITY_OBSERVATION_TIME)
      }
    }, this.CONSTANTS.AUTO_QUALITY_SCHEDULER)
  }

  private isPlayerWaiting () {
    return this.player && this.player.hasClass('vjs-waiting')
  }

  private runTorrentInfoScheduler () {
    this.torrentInfoInterval = setInterval(() => {
      // Not initialized yet
      if (this.torrent === undefined) return

      // Http fallback
      if (this.torrent === null) return this.trigger('torrentInfo', false)

      // this.webtorrent.downloadSpeed because we need to take into account the potential old torrent too
      if (this.webtorrent.downloadSpeed !== 0) this.downloadSpeeds.push(this.webtorrent.downloadSpeed)

      return this.trigger('torrentInfo', {
        downloadSpeed: this.torrent.downloadSpeed,
        numPeers: this.torrent.numPeers,
        uploadSpeed: this.torrent.uploadSpeed,
        downloaded: this.torrent.downloaded,
        uploaded: this.torrent.uploaded
      })
    }, this.CONSTANTS.INFO_SCHEDULER)
  }

  private runViewAdd () {
    this.clearVideoViewInterval()

    // After 30 seconds (or 3/4 of the video), add a view to the video
    let minSecondsToView = 30

    if (this.videoDuration < minSecondsToView) minSecondsToView = (this.videoDuration * 3) / 4

    let secondsViewed = 0
    this.videoViewInterval = setInterval(() => {
      if (this.player && !this.player.paused()) {
        secondsViewed += 1

        if (secondsViewed > minSecondsToView) {
          this.clearVideoViewInterval()

          this.addViewToVideo().catch(err => console.error(err))
        }
      }
    }, 1000)
  }

  private runUserWatchVideo (options: UserWatching) {
    let lastCurrentTime = 0

    this.userWatchingVideoInterval = setInterval(() => {
      const currentTime = Math.floor(this.player.currentTime())

      if (currentTime - lastCurrentTime >= 1) {
        lastCurrentTime = currentTime

        this.notifyUserIsWatching(currentTime, options.url, options.authorizationHeader)
          .catch(err => console.error('Cannot notify user is watching.', err))
      }
    }, this.CONSTANTS.USER_WATCHING_VIDEO_INTERVAL)
  }

  private clearVideoViewInterval () {
    if (this.videoViewInterval !== undefined) {
      clearInterval(this.videoViewInterval)
      this.videoViewInterval = undefined
    }
  }

  private addViewToVideo () {
    if (!this.videoViewUrl) return Promise.resolve(undefined)

    return fetch(this.videoViewUrl, { method: 'POST' })
  }

  private notifyUserIsWatching (currentTime: number, url: string, authorizationHeader: string) {
    const body = new URLSearchParams()
    body.append('currentTime', currentTime.toString())

    const headers = new Headers({ 'Authorization': authorizationHeader })

    return fetch(url, { method: 'PUT', body, headers })
  }

  private fallbackToHttp (options: PlayOptions, done?: Function) {
    const paused = this.player.paused()

    this.disableAutoResolution(true)

    this.flushVideoFile(this.currentVideoFile, true)
    this.torrent = null

    // Enable error display now this is our last fallback
    this.player.one('error', () => this.enableErrorDisplay())

    const httpUrl = this.currentVideoFile.fileUrl
    this.player.src = this.savePlayerSrcFunction
    this.player.src(httpUrl)

    return this.tryToPlay(err => {
      if (err && done) return done(err)

      if (options.seek) this.seek(options.seek)
      if (options.forcePlay === false && paused === true) this.player.pause()

      if (done) return done()
    })
  }

  private handleError (err: Error | string) {
    return this.player.trigger('customError', { err })
  }

  private enableErrorDisplay () {
    this.player.addClass('vjs-error-display-enabled')
  }

  private disableErrorDisplay () {
    this.player.removeClass('vjs-error-display-enabled')
  }

  private isIOS () {
    return !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform)
  }

  private alterInactivity () {
    let saveInactivityTimeout: number

    const disableInactivity = () => {
      saveInactivityTimeout = this.player.options_.inactivityTimeout
      this.player.options_.inactivityTimeout = 0
    }
    const enableInactivity = () => {
      this.player.options_.inactivityTimeout = saveInactivityTimeout
    }

    const settingsDialog = this.player.children_.find((c: any) => c.name_ === 'SettingsDialog')

    this.player.controlBar.on('mouseenter', () => disableInactivity())
    settingsDialog.on('mouseenter', () => disableInactivity())
    this.player.controlBar.on('mouseleave', () => enableInactivity())
    settingsDialog.on('mouseleave', () => enableInactivity())
  }

  private pickAverageVideoFile () {
    if (this.videoFiles.length === 1) return this.videoFiles[0]

    return this.videoFiles[Math.floor(this.videoFiles.length / 2)]
  }

  private stopTorrent (torrent: WebTorrent.Torrent) {
    torrent.pause()
    // Pause does not remove actual peers (in particular the webseed peer)
    torrent.removePeer(torrent[ 'ws' ])
  }

  private renderFileInFakeElement (file: WebTorrent.TorrentFile, delay: number) {
    this.destroyingFakeRenderer = false

    const fakeVideoElem = document.createElement('video')
    renderVideo(file, fakeVideoElem, { autoplay: false, controls: false }, (err, renderer) => {
      this.fakeRenderer = renderer

      // The renderer returns an error when we destroy it, so skip them
      if (this.destroyingFakeRenderer === false && err) {
        console.error('Cannot render new torrent in fake video element.', err)
      }

      // Load the future file at the correct time (in delay MS - 2 seconds)
      fakeVideoElem.currentTime = this.player.currentTime() + (delay - 2000)
    })
  }

  private destroyFakeRenderer () {
    if (this.fakeRenderer) {
      this.destroyingFakeRenderer = true

      if (this.fakeRenderer.destroy) {
        try {
          this.fakeRenderer.destroy()
        } catch (err) {
          console.log('Cannot destroy correctly fake renderer.', err)
        }
      }
      this.fakeRenderer = undefined
    }
  }

  private initCaptions () {
    for (const caption of this.videoCaptions) {
      this.player.addRemoteTextTrack({
        kind: 'captions',
        label: caption.label,
        language: caption.language,
        id: caption.language,
        src: caption.src,
        default: this.defaultSubtitle === caption.language
      }, false)
    }
  }

  // Thanks: https://github.com/videojs/video.js/issues/4460#issuecomment-312861657
  private initSmoothProgressBar () {
    const SeekBar = videojsUntyped.getComponent('SeekBar')
    SeekBar.prototype.getPercent = function getPercent () {
      // Allows for smooth scrubbing, when player can't keep up.
      // const time = (this.player_.scrubbing()) ?
      //   this.player_.getCache().currentTime :
      //   this.player_.currentTime()
      const time = this.player_.currentTime()
      const percent = time / this.player_.duration()
      return percent >= 1 ? 1 : percent
    }
    SeekBar.prototype.handleMouseMove = function handleMouseMove (event: any) {
      let newTime = this.calculateDistance(event) * this.player_.duration()
      if (newTime === this.player_.duration()) {
        newTime = newTime - 0.1
      }
      this.player_.currentTime(newTime)
      this.update()
    }
  }
}

videojs.registerPlugin('peertube', PeerTubePlugin)
export { PeerTubePlugin }
