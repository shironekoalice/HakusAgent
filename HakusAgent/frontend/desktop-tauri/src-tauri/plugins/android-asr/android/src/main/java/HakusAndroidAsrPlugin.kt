package com.hakusai.androidasr

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineSenseVoiceModelConfig
import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max

private const val EXTENSION_ID = "voice.celia"
private const val MODEL_CARD = "iic/SenseVoiceSmall"
private const val SHERPA_RELEASE = "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17"
private const val MODEL_FILE = "model.int8.onnx"
private const val TOKENS_FILE = "tokens.txt"
private const val RECORD_AUDIO_REQUEST = 7401
private const val SAMPLE_RATE = 16_000
private const val MAX_RECORDING_SECONDS = 30
private const val FEATURE_DIM = 80

@InvokeArg
class StartArgs {
  var modelDir: String = ""
  var language: String = "auto"
}

@TauriPlugin
class HakusAndroidAsrPlugin(private val activity: Activity) : Plugin(activity) {
  private val lock = Any()
  private val decodeExecutor: ExecutorService = Executors.newSingleThreadExecutor()

  @Volatile private var running = false
  @Volatile private var processing = false
  @Volatile private var stopRequested = false

  private var modelDir: File? = null
  private var language = "auto"
  private var recorder: AudioRecord? = null
  private var recordingThread: Thread? = null
  private var recognizer: OfflineRecognizer? = null
  private var samples = FloatArray(SAMPLE_RATE * MAX_RECORDING_SECONDS)
  private var sampleCount = 0
  private var lastTranscript: String? = null
  private var lastError: String? = null

  @Command
  fun status(invoke: Invoke) {
    invoke.resolve(statusObject())
  }

  @Command
  fun start(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(StartArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Android ASR start arguments are invalid")
      return
    }

    val directory = resolveModelDirectory(args.modelDir)
    val readinessError = readiness(directory)
    if (readinessError != null) {
      invoke.resolve(statusObject(readinessError, directory))
      return
    }
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST)
      invoke.resolve(statusObject("microphone permission required", directory))
      return
    }

    synchronized(lock) {
      if (running || processing) {
        invoke.resolve(statusObject(directory = modelDir))
        return
      }
      modelDir = directory
      language = args.language.trim().ifEmpty { "auto" }
      lastTranscript = null
      lastError = null
      sampleCount = 0
      stopRequested = false
      processing = true
    }

    decodeExecutor.execute {
      try {
        val recognizerInstance = createRecognizer(directory)
        val audioRecord = createRecorder()
        synchronized(lock) {
          recognizer = recognizerInstance
          recorder = audioRecord
          running = true
          processing = false
          recordingThread = Thread({ captureLoop(audioRecord) }, "hakus-android-asr-capture")
          recordingThread?.start()
        }
        invoke.resolve(statusObject(directory = directory))
      } catch (error: Exception) {
        synchronized(lock) {
          recognizer?.release()
          recognizer = null
          recorder?.release()
          recorder = null
          running = false
          lastError = error.message ?: "Android ASR could not start"
        }
        invoke.resolve(statusObject(lastError, directory))
      }
    }
  }

  @Command
  fun stop(invoke: Invoke) {
    val captureThread: Thread?
    val audioRecord: AudioRecord?
    synchronized(lock) {
      if (!running && !processing) {
        val result = statusObject()
        result.put("error", null)
        invoke.resolve(result)
        return
      }
      stopRequested = true
      running = false
      processing = true
      captureThread = recordingThread
      audioRecord = recorder
    }

    try {
      audioRecord?.stop()
    } catch (_: IllegalStateException) {
      // The capture thread may have already stopped the recorder.
    }

    decodeExecutor.execute {
      try {
        if (captureThread != null && captureThread !== Thread.currentThread()) {
          captureThread.join(3_000)
        }
        audioRecord?.release()
        val transcript = decodeCapturedAudio()
        synchronized(lock) {
          lastTranscript = transcript
          lastError = null
        }
      } catch (error: Exception) {
        synchronized(lock) {
          lastTranscript = null
          lastError = error.message ?: "Android ASR transcription failed"
        }
      } finally {
        synchronized(lock) {
          recorder = null
          recordingThread = null
          recognizer?.release()
          recognizer = null
          processing = false
          stopRequested = false
        }
        val result = statusObject(directory = modelDir)
        result.put("running", false)
        result.put("state", "unavailable")
        result.put("error", lastError)
        result.put("transcript", lastTranscript)
        invoke.resolve(result)
      }
    }
  }

  private fun createRecorder(): AudioRecord {
    val channel = AudioFormat.CHANNEL_IN_MONO
    val encoding = AudioFormat.ENCODING_PCM_16BIT
    val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, channel, encoding)
    if (minimum <= 0) throw IllegalStateException("Android microphone is unavailable")
    return AudioRecord(
      MediaRecorder.AudioSource.MIC,
      SAMPLE_RATE,
      channel,
      encoding,
      max(minimum, SAMPLE_RATE / 2),
    ).also { record ->
      if (record.state != AudioRecord.STATE_INITIALIZED) {
        record.release()
        throw IllegalStateException("Android microphone could not be initialized")
      }
      record.startRecording()
    }
  }

  private fun captureLoop(audioRecord: AudioRecord) {
    val buffer = ShortArray(2_048)
    try {
      while (!stopRequested) {
        val read = audioRecord.read(buffer, 0, buffer.size)
        if (read <= 0) continue
        synchronized(lock) {
          val available = samples.size - sampleCount
          val count = minOf(read, available)
          for (index in 0 until count) {
            samples[sampleCount + index] = buffer[index] / 32_768.0f
          }
          sampleCount += count
          if (sampleCount == samples.size) stopRequested = true
        }
      }
    } finally {
      try {
        audioRecord.stop()
      } catch (_: IllegalStateException) {
        // Already stopped by the command handler.
      }
    }
  }

  private fun decodeCapturedAudio(): String {
    val audio: FloatArray
    val length: Int
    val activeRecognizer: OfflineRecognizer
    synchronized(lock) {
      length = sampleCount
      audio = samples.copyOf(length)
      activeRecognizer = recognizer ?: throw IllegalStateException("Android ASR recognizer is unavailable")
    }
    if (audio.isEmpty()) return ""

    val stream = activeRecognizer.createStream()
    return try {
      stream.acceptWaveform(audio, SAMPLE_RATE)
      activeRecognizer.decode(stream)
      activeRecognizer.getResult(stream).text.trim()
    } finally {
      stream.release()
    }
  }

  private fun createRecognizer(directory: File): OfflineRecognizer {
    val model = OfflineSenseVoiceModelConfig().apply {
      model = File(directory, MODEL_FILE).absolutePath
      language = this@HakusAndroidAsrPlugin.language
      useInverseTextNormalization = true
    }
    val modelConfig = OfflineModelConfig().apply {
      senseVoice = model
      tokens = File(directory, TOKENS_FILE).absolutePath
      modelType = "sense_voice"
      provider = "cpu"
      numThreads = 2
      debug = false
    }
    val config = OfflineRecognizerConfig().apply {
      featConfig = FeatureConfig(SAMPLE_RATE, FEATURE_DIM, 0.0f)
      this.modelConfig = modelConfig
      decodingMethod = "greedy_search"
    }
    return OfflineRecognizer(activity.assets, config)
  }

  private fun resolveModelDirectory(requested: String): File {
    val candidate = requested.trim()
    return if (candidate.isNotEmpty()) File(candidate) else File(activity.filesDir, "models/sensevoice")
  }

  private fun readiness(directory: File): String? {
    if (!directory.isDirectory) return "external SenseVoice model directory is not configured"
    if (!File(directory, MODEL_FILE).isFile) return "external SenseVoice model.int8.onnx is missing"
    if (!File(directory, TOKENS_FILE).isFile) return "external SenseVoice tokens.txt is missing"
    return null
  }

  private fun sherpaRuntimePresent(): Boolean = try {
    Class.forName("com.k2fsa.sherpa.onnx.OfflineRecognizer")
    true
  } catch (_: ClassNotFoundException) {
    false
  }

  private fun statusObject(error: String? = null, directory: File? = modelDir): JSObject {
    val selected = directory ?: resolveModelDirectory("")
    val modelReady = readiness(selected) == null
    val runtimeReady = sherpaRuntimePresent()
    val result = JSObject()
    result.put("extension_id", EXTENSION_ID)
    result.put("state", if (running || processing) "started" else "unavailable")
    result.put("running", running)
    result.put("processing", processing)
    result.put("pid", null)
    result.put("model_card", MODEL_CARD)
    result.put("sherpa_release", SHERPA_RELEASE)
    result.put("model_ready", modelReady)
    result.put("runtime_ready", runtimeReady)
    result.put("model_dir_name", selected.name)
    result.put("transcript", lastTranscript)
    result.put(
      "error",
      error ?: lastError ?: when {
        !modelReady -> readiness(selected)
        !runtimeReady -> "sherpa-onnx Android runtime is not provisioned"
        else -> null
      },
    )
    return result
  }
}
