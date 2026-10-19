package com.hakusai.client

import android.os.Bundle
import android.view.ViewGroup
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Edge-to-edge means the WebView renders under the status bar and the
    // navigation bar. Android WebView does not translate WindowInsets into
    // CSS env(safe-area-inset-*), so the web content needs the insets applied
    // as real padding. Pad android.R.id.content itself: it exists from
    // setContentView time, survives view swaps, and is the parent of whatever
    // view Tauri installs. The WebView then lays out inside the padded area.
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      // Consume the insets so children (Tauri's WebView host) do not apply
      // them a second time.
      WindowInsetsCompat.CONSUMED
    }
  }
}
