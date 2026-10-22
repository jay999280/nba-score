package com.jay.nbascore;

import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge == null ? null : bridge.getWebView();
                if (webView == null) {
                    finish();
                    return;
                }

                // The JS handler uses the existing route receipts before it
                // traverses history (and closes the favorites sheet first).
                // During startup, before React installs it, fall back to the
                // actual WebView history and then the local home route.
                webView.evaluateJavascript(
                    "typeof window.__nbaHandleNativeBack === 'function' " +
                        "? window.__nbaHandleNativeBack() : 'not-ready'",
                    result -> {
                        if ("\"exit\"".equals(result)) {
                            finish();
                        } else if ("\"not-ready\"".equals(result)) {
                            if (webView.canGoBack()) {
                                webView.goBack();
                                return;
                            }
                            Uri current = Uri.parse(webView.getUrl() == null ? "" : webView.getUrl());
                            if (!"/".equals(current.getPath())) {
                                webView.evaluateJavascript("window.location.replace('/')", null);
                            } else {
                                finish();
                            }
                        }
                    }
                );
            }
        });
    }
}
