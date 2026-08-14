import UIKit
import WebKit

/// The shell: a WKWebView on the deployed SPA plus the native behaviors a
/// browser tab can't provide — the bridge (ShellBridge), a native
/// offline/error screen (the airplane-mode review test), and link routing:
/// external hosts to Safari, window.open/blob URLs (the zone-file viewer —
/// shell.md, known gaps) to an in-app child WebView that shares the parent's
/// browsing context. Login stays inside the webview (plans/mobile.md,
/// platform gotchas — bouncing to Safari for auth is rejectable).
final class ShellViewController: UIViewController {
  private var webView: WKWebView!
  private var bridge: ShellBridge!
  private let errorView = UIView()
  private let webOrigin: URL
  private let startURL: URL

  /// Schemes allowed to leave the app from a plain link navigation —
  /// mirrors the Android shell; the bridge's external.open already enforces
  /// http/https, and this path must not be the looser one.
  private static let externalSchemes: Set<String> = ["http", "https", "mailto", "tel"]

  private static let connectivityErrorCodes: Set<URLError.Code> = [
    .notConnectedToInternet, .networkConnectionLost, .cannotFindHost,
    .cannotConnectToHost, .dnsLookupFailed, .timedOut,
  ]

  init() {
    guard
      let origin = Bundle.main.object(forInfoDictionaryKey: "VirtuWebOrigin") as? String,
      let originURL = URL(string: origin),
      let start = URL(string: origin + "/app/")
    else {
      fatalError("VirtuWebOrigin missing/invalid in Info.plist — check project.yml")
    }
    webOrigin = originURL
    startURL = start
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("not using storyboards") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground

    let configuration = WKWebViewConfiguration()
    bridge = ShellBridge(keychain: KeychainStore(), presenter: self)
    bridge.attach(to: configuration.userContentController)

    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.allowsBackForwardNavigationGestures = true
    webView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.topAnchor.constraint(equalTo: view.topAnchor),
      webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    buildErrorView()
    webView.load(URLRequest(url: startURL))
  }

  // MARK: - Offline/error screen

  private func buildErrorView() {
    errorView.backgroundColor = .systemBackground
    errorView.isHidden = true
    errorView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(errorView)
    NSLayoutConstraint.activate([
      errorView.topAnchor.constraint(equalTo: view.topAnchor),
      errorView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      errorView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      errorView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])

    let title = UILabel()
    title.text = "You're offline"
    title.font = .preferredFont(forTextStyle: .title2)

    let body = UILabel()
    body.text = "virtu needs a connection.\nCheck your network and try again."
    body.font = .preferredFont(forTextStyle: .body)
    body.textColor = .secondaryLabel
    body.numberOfLines = 0
    body.textAlignment = .center

    var retryConfig = UIButton.Configuration.borderedProminent()
    retryConfig.title = "Retry"
    let retry = UIButton(configuration: retryConfig, primaryAction: UIAction { [weak self] _ in
      guard let self else { return }
      errorView.isHidden = true
      if webView.url != nil { webView.reload() } else { webView.load(URLRequest(url: startURL)) }
    })

    let stack = UIStackView(arrangedSubviews: [title, body, retry])
    stack.axis = .vertical
    stack.alignment = .center
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    errorView.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: errorView.centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: errorView.centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: errorView.leadingAnchor, constant: 32),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: errorView.trailingAnchor, constant: -32),
    ])
  }

  private func showOfflineScreen(for error: Error) {
    guard let urlError = error as? URLError,
          Self.connectivityErrorCodes.contains(urlError.code)
    else { return } // aborted/superseded loads must not flash the screen
    errorView.isHidden = false
  }

  // MARK: - Link routing

  private func sameOrigin(_ url: URL) -> Bool {
    func defaultedPort(_ u: URL) -> Int? {
      if let port = u.port { return port }
      switch u.scheme?.lowercased() {
      case "http": return 80
      case "https": return 443
      default: return nil
      }
    }
    guard let host = url.host else { return false }
    return url.scheme?.lowercased() == webOrigin.scheme?.lowercased()
      && host.lowercased() == webOrigin.host?.lowercased()
      && defaultedPort(url) == defaultedPort(webOrigin)
  }

  /// True (and hands the URL to the system) for navigations leaving the app
  /// origin. Links inside email bodies don't reach here at all: the web app
  /// sends those over the bridge as external.open.
  private func routeAwayFromApp(_ url: URL) -> Bool {
    if url.scheme == "blob" || url.scheme == "about" || sameOrigin(url) { return false }
    guard let scheme = url.scheme?.lowercased(), Self.externalSchemes.contains(scheme) else {
      return true // swallow: no intent-style or app-scheme escapes from web content
    }
    UIApplication.shared.open(url, options: [:])
    return true
  }

  /// Child window for window.open/target=_blank: created with the
  /// configuration WebKit hands us, which keeps it in the parent's browsing
  /// context — that's what lets a blob: URL from the parent's JS resolve
  /// here (shell.md, known gaps).
  fileprivate func presentChildWebView(configuration: WKWebViewConfiguration) -> WKWebView {
    let child = WKWebView(frame: .zero, configuration: configuration)
    child.navigationDelegate = self
    child.uiDelegate = self

    let host = UIViewController()
    host.view.backgroundColor = .systemBackground
    child.translatesAutoresizingMaskIntoConstraints = false
    host.view.addSubview(child)
    NSLayoutConstraint.activate([
      child.topAnchor.constraint(equalTo: host.view.topAnchor),
      child.bottomAnchor.constraint(equalTo: host.view.bottomAnchor),
      child.leadingAnchor.constraint(equalTo: host.view.leadingAnchor),
      child.trailingAnchor.constraint(equalTo: host.view.trailingAnchor),
    ])
    host.navigationItem.rightBarButtonItem = UIBarButtonItem(
      systemItem: .close,
      primaryAction: UIAction { [weak host] _ in host?.dismiss(animated: true) }
    )
    present(UINavigationController(rootViewController: host), animated: true)
    return child
  }
}

extension ShellViewController: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView,
    decidePolicyFor navigationAction: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
    decisionHandler(routeAwayFromApp(url) ? .cancel : .allow)
  }

  func webView(
    _ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error
  ) {
    if webView === self.webView { showOfflineScreen(for: error) }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if webView === self.webView { showOfflineScreen(for: error) }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    if webView === self.webView { errorView.isHidden = true }
  }
}

extension ShellViewController: WKUIDelegate {
  func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    // External-host targets go straight to Safari; blob/same-origin get the
    // in-app child window (whose delegate routing also catches later hops).
    if let url = navigationAction.request.url,
       url.scheme != "blob", url.scheme != "about", !sameOrigin(url) {
      _ = routeAwayFromApp(url)
      return nil
    }
    return presentChildWebView(configuration: configuration)
  }

  func webViewDidClose(_ webView: WKWebView) {
    if webView !== self.webView { presentedViewController?.dismiss(animated: true) }
  }
}
