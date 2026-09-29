use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{
    webview::NewWindowResponse, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager,
    WebviewUrl,
};
use url::Url;

const WEBVIEW_LABEL_PREFIX: &str = "hakus-browser-";

#[derive(Debug, Deserialize)]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Deserialize)]
pub struct BrowserAction {
    action: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    selector: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    direction: Option<String>,
    #[serde(default)]
    amount: Option<u16>,
}

#[tauri::command]
pub async fn browser_create(
    app: AppHandle,
    tab_id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let label = webview_label(&tab_id)?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "Main window is not available".to_string())?;
    let position = LogicalPosition::new(bounds.x, bounds.y);
    let size = LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0));

    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(position)
            .and_then(|_| webview.set_size(size))
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    // WebView2 needs a normal first navigation before the child can be reused.
    let url = Url::parse("https://example.com").map_err(|error| error.to_string())?;
    let location_app = app.clone();
    let location_tab = tab_id.clone();
    let page_app = app.clone();
    let page_tab = tab_id.clone();
    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let new_window_app = app.clone();
    let new_window_tab = tab_id.clone();
    let startup_navigation = Arc::new(AtomicBool::new(true));
    let navigation_startup = startup_navigation.clone();
    let page_startup = startup_navigation;
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        .initialization_script(new_tab_routing_script())
        .on_navigation(move |url| {
            let is_blank = url.as_str() == "about:blank";
            let allowed = matches!(url.scheme(), "http" | "https") || is_blank;
            if is_blank {
                navigation_startup.store(false, Ordering::Release);
            } else if allowed && !navigation_startup.load(Ordering::Acquire) {
                let _ = location_app.emit(
                    "browser-location-changed",
                    json!({ "tabId": location_tab, "url": url.as_str() }),
                );
            }
            allowed
        })
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = new_window_app.emit(
                    "browser-new-tab-requested",
                    json!({ "sourceTabId": new_window_tab, "url": url.as_str() }),
                );
            }
            NewWindowResponse::Deny
        })
        .on_page_load(move |webview, payload| {
            if payload.url().as_str() == "about:blank"
                || (payload.url().host_str() == Some("example.com")
                    && (page_startup.load(Ordering::Acquire)
                        || webview
                            .url()
                            .map(|current| current.as_str() != payload.url().as_str())
                            .unwrap_or(true)))
            {
                return;
            }
            let _ = page_app.emit(
                "browser-page-load",
                json!({
                    "tabId": page_tab,
                    "url": payload.url().as_str(),
                    "loading": payload.event() == tauri::webview::PageLoadEvent::Started,
                }),
            );
        })
        .on_document_title_changed(move |_webview, title| {
            let _ = title_app.emit(
                "browser-title-changed",
                json!({ "tabId": title_tab, "title": title }),
            );
        });

    let webview = window
        .add_child(builder, position, size)
        .map_err(|error| format!("Create embedded browser: {error}"))?;
    webview.hide().map_err(|error| error.to_string())?;
    let blank = Url::parse("about:blank").map_err(|error| error.to_string())?;
    webview
        .navigate(blank)
        .map_err(|error| format!("Initialize browser tab: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    tab_id: String,
    bounds: BrowserBounds,
) -> Result<(), String> {
    let webview = browser_webview(&app, &tab_id)?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| {
            webview.set_size(LogicalSize::new(
                bounds.width.max(1.0),
                bounds.height.max(1.0),
            ))
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn browser_select_tab(
    app: AppHandle,
    tab_id: String,
    tab_ids: Vec<String>,
    bounds: BrowserBounds,
    show_page: bool,
) -> Result<(), String> {
    let active_label = webview_label(&tab_id)?;
    for other_id in tab_ids {
        if other_id == tab_id {
            continue;
        }
        let other_label = webview_label(&other_id)?;
        if let Some(webview) = app.get_webview(&other_label) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }

    let webview = app
        .get_webview(&active_label)
        .ok_or_else(|| "Browser tab has not been created".to_string())?;
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .and_then(|_| {
            webview.set_size(LogicalSize::new(
                bounds.width.max(1.0),
                bounds.height.max(1.0),
            ))
        })
        .map_err(|error| error.to_string())?;

    if !show_page {
        webview.hide().map_err(|error| error.to_string())
    } else {
        webview.show().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub fn browser_hide_tabs(app: AppHandle, tab_ids: Vec<String>) -> Result<(), String> {
    for tab_id in tab_ids {
        let label = webview_label(&tab_id)?;
        if let Some(webview) = app.get_webview(&label) {
            webview.hide().map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_close_tab(app: AppHandle, tab_id: String) -> Result<(), String> {
    let label = webview_label(&tab_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_current_url(app: AppHandle, tab_id: String) -> Result<String, String> {
    browser_webview(&app, &tab_id)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn browser_action(
    app: AppHandle,
    tab_id: String,
    action: BrowserAction,
) -> Result<Value, String> {
    let webview = browser_webview(&app, &tab_id)?;
    let mut result = match action.action.as_str() {
        "navigate" => {
            let url = validated_url(action.url.as_deref().unwrap_or_default())?;
            webview
                .show()
                .and_then(|_| webview.navigate(url.clone()))
                .map_err(|error| format!("Navigate browser: {error}"))?;
            Ok(json!({ "ok": true, "url": url.as_str(), "status": "navigating" }))
        }
        "clear" => {
            let url = Url::parse("about:blank").map_err(|error| error.to_string())?;
            webview
                .navigate(url.clone())
                .and_then(|_| webview.hide())
                .map_err(|error| format!("Clear browser page: {error}"))?;
            Ok(json!({ "ok": true, "url": url.as_str() }))
        }
        "snapshot" => evaluate(&webview, snapshot_script()).await,
        "click" => {
            let script = click_script(action.selector.as_deref(), action.text.as_deref())?;
            evaluate(&webview, script).await
        }
        "fill" => {
            let selector = action
                .selector
                .as_deref()
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Fill requires a CSS selector".to_string())?;
            if selector.len() > 512 {
                return Err("CSS selector is too long".into());
            }
            evaluate(
                &webview,
                fill_script(selector, action.value.as_deref().unwrap_or_default()),
            )
            .await
        }
        "press" => {
            let key = action
                .key
                .as_deref()
                .filter(|value| valid_key(value))
                .ok_or_else(|| "Press requires a supported key name".to_string())?;
            evaluate(&webview, press_script(key)).await
        }
        "scroll" => {
            let direction = action.direction.as_deref().unwrap_or("down");
            if !matches!(direction, "up" | "down" | "left" | "right") {
                return Err("Scroll direction must be up, down, left, or right".into());
            }
            evaluate(
                &webview,
                scroll_script(direction, action.amount.unwrap_or(600).clamp(50, 1500)),
            )
            .await
        }
        "back" => {
            evaluate(
                &webview,
                "(() => { history.back(); return { ok: true }; })()".into(),
            )
            .await
        }
        "forward" => {
            evaluate(
                &webview,
                "(() => { history.forward(); return { ok: true }; })()".into(),
            )
            .await
        }
        "reload" => {
            evaluate(
                &webview,
                "(() => { location.reload(); return { ok: true }; })()".into(),
            )
            .await
        }
        _ => return Err("Unsupported browser action".into()),
    }?;
    if let Some(object) = result.as_object_mut() {
        if let Ok(url) = webview.url() {
            object.entry("url").or_insert_with(|| json!(url.as_str()));
        }
    }
    Ok(result)
}

fn browser_webview(app: &AppHandle, tab_id: &str) -> Result<tauri::Webview<tauri::Wry>, String> {
    let label = webview_label(tab_id)?;
    app.get_webview(&label)
        .ok_or_else(|| "Open the browser panel before using browser controls".to_string())
}

fn webview_label(tab_id: &str) -> Result<String, String> {
    if tab_id.is_empty()
        || tab_id.len() > 64
        || !tab_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid browser tab identifier".into());
    }
    Ok(format!("{WEBVIEW_LABEL_PREFIX}{tab_id}"))
}

fn validated_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("Invalid URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Browser navigation accepts only http and https URLs".into());
    }
    Ok(url)
}

fn new_tab_routing_script() -> &'static str {
    r#"(() => {
      const openInTab = (href) => {
        let url;
        try { url = new URL(href, location.href); } catch { return false; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
        window.open(url.href, '_blank');
        return true;
      };
      const findLink = (event) => event.composedPath().find((node) =>
        node instanceof HTMLAnchorElement && node.href
      );
      document.addEventListener('click', (event) => {
        if (event.defaultPrevented || event.button !== 0) return;
        const link = findLink(event);
        if (!link || link.hasAttribute('download')) return;
        const opensNewTab = link.target.toLowerCase() === '_blank' || event.ctrlKey || event.metaKey;
        if (!opensNewTab || !openInTab(link.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      document.addEventListener('auxclick', (event) => {
        if (event.defaultPrevented || event.button !== 1) return;
        const link = findLink(event);
        if (!link || link.hasAttribute('download') || !openInTab(link.href)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
    })();"#
}

async fn evaluate(webview: &tauri::Webview<tauri::Wry>, script: String) -> Result<Value, String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let script = format!(
        "(() => {{ try {{ return {script}; }} catch (error) {{ return {{ ok: false, error: String(error) }}; }} }})()"
    );
    webview
        .eval_with_callback(script, move |result| {
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Run browser action: {error}"))?;
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), rx.recv())
        .await
        .map_err(|_| "Browser action timed out".to_string())?
        .ok_or_else(|| "Browser action ended before returning a result".to_string())?;
    serde_json::from_str(&result).map_err(|_| result)
}

fn snapshot_script() -> String {
    r#"(() => ({
      ok: true,
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 10000),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 24).map((a) => ({
        text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 160),
        href: a.href
      })),
      controls: Array.from(document.querySelectorAll('button,input,textarea,select,[role="button"]')).slice(0, 24).map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        label: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120)
      }))
    }))()"#.into()
}

fn click_script(selector: Option<&str>, text: Option<&str>) -> Result<String, String> {
    if selector.is_some_and(|selector| selector.len() > 512) {
        return Err("CSS selector is too long".into());
    }
    let selector =
        serde_json::to_string(&selector.unwrap_or_default()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string(&text.unwrap_or_default()).map_err(|e| e.to_string())?;
    if selector.len() > 1024 || text.len() > 1024 {
        return Err("Browser click target is too long".into());
    }
    Ok(format!(
        r#"(() => {{
          const selector = {selector};
          const wanted = {text}.trim();
          let el = selector ? document.querySelector(selector) : null;
          if (!el && wanted) el = Array.from(document.querySelectorAll('button,a,[role="button"]')).find((item) => (item.innerText || item.getAttribute('aria-label') || '').trim() === wanted);
          if (!el) return {{ ok: false, error: 'Target not found' }};
          el.scrollIntoView({{ block: 'center', inline: 'nearest' }});
          el.click();
          return {{ ok: true, text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 160) }};
        }})()"#
    ))
}

fn fill_script(selector: &str, value: &str) -> String {
    let selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    let value = serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(() => {{
          const el = document.querySelector({selector});
          if (!el) return {{ ok: false, error: 'Target not found' }};
          el.focus();
          if (el.isContentEditable) el.innerText = {value};
          else {{
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, {value}); else el.value = {value};
          }}
          el.dispatchEvent(new Event('input', {{ bubbles: true }}));
          el.dispatchEvent(new Event('change', {{ bubbles: true }}));
          return {{ ok: true }};
        }})()"#
    )
}

fn press_script(key: &str) -> String {
    let key = serde_json::to_string(key).unwrap_or_else(|_| "\"Enter\"".into());
    format!(
        r#"(() => {{
          const el = document.activeElement || document.body;
          const event = new KeyboardEvent('keydown', {{ key: {key}, bubbles: true, cancelable: true }});
          el.dispatchEvent(event);
          el.dispatchEvent(new KeyboardEvent('keyup', {{ key: {key}, bubbles: true, cancelable: true }}));
          return {{ ok: true, key: {key} }};
        }})()"#
    )
}

fn scroll_script(direction: &str, amount: u16) -> String {
    let delta = match direction {
        "up" => (0, -(amount as i32)),
        "left" => (-(amount as i32), 0),
        "right" => (amount as i32, 0),
        _ => (0, amount as i32),
    };
    format!(
        "(() => {{ window.scrollBy({{ left: {}, top: {}, behavior: 'instant' }}); return {{ ok: true }}; }})()",
        delta.0, delta.1
    )
}

fn valid_key(value: &str) -> bool {
    matches!(
        value,
        "Enter"
            | "Tab"
            | "Escape"
            | "Backspace"
            | "Delete"
            | "Space"
            | "ArrowUp"
            | "ArrowDown"
            | "ArrowLeft"
            | "ArrowRight"
    ) || (value.len() == 1
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric()))
}

#[cfg(test)]
mod tests {
    use super::{new_tab_routing_script, validated_url};

    #[test]
    fn browser_navigation_rejects_non_web_schemes() {
        assert!(validated_url("javascript:alert(1)").is_err());
        assert!(validated_url("file:///C:/Windows/win.ini").is_err());
        assert!(validated_url("https://example.com").is_ok());
    }

    #[test]
    fn new_tab_routing_covers_blank_modifier_and_middle_clicks() {
        let script = new_tab_routing_script();
        assert!(script.contains("link.target.toLowerCase() === '_blank'"));
        assert!(script.contains("event.ctrlKey || event.metaKey"));
        assert!(script.contains("event.button !== 1"));
        assert!(script.contains("link.hasAttribute('download')"));
        assert!(script.contains("url.protocol !== 'http:' && url.protocol !== 'https:'"));
    }
}
