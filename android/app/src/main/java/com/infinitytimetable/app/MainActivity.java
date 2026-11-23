package com.infinitytimetable.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Infinity Timetable for Android: the same timetable app, running offline inside a WebView.
 * The page is served from the app's own assets on a private https address, so browser storage
 * and the licence check work exactly as on Windows. ITAndroid lets the page save, share,
 * print and open links the Android way.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/assets/app/index.html";
    static final int REQ_FILE = 11;
    static final int REQ_SAVE = 12;

    WebView web;
    ValueCallback<Uri[]> fileCallback;
    byte[] pendingBytes;
    String pendingName;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        setContentView(web);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setSupportMultipleWindows(false);
        // Sync with the school PC over Wi-Fi: the page is https, the PC is plain http on the local network
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        web.addJavascriptInterface(new Bridge(), "ITAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (HOST.equals(u.getHost())) return false;
                openExternal(u.toString());
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                String type = "*/*";
                String[] accept = params.getAcceptTypes();
                if (accept != null && accept.length == 1 && accept[0] != null && accept[0].startsWith("image/")) type = accept[0];
                i.setType(type);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose a file"), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(START);
    }

    /** Methods the page can call as window.ITAndroid.* */
    class Bridge {
        @JavascriptInterface
        public void saveFile(final String name, final String mime, final String base64) {
            final byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            runOnUiThread(() -> askSaveOrShare(name, mime, bytes));
        }

        @JavascriptInterface
        public void print(final String title) {
            runOnUiThread(() -> doPrint(title));
        }

        @JavascriptInterface
        public void openUrl(final String url) {
            runOnUiThread(() -> openExternal(url));
        }

        @JavascriptInterface
        public void scanQR() {
            runOnUiThread(() -> doScan());
        }

        @JavascriptInterface
        public void exit() {
            runOnUiThread(() -> finishAndRemoveTask());
        }
    }

    void doScan() {
        try {
            GmsBarcodeScannerOptions o = new GmsBarcodeScannerOptions.Builder()
                    .setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
            GmsBarcodeScanner sc = GmsBarcodeScanning.getClient(this, o);
            sc.startScan()
                    .addOnSuccessListener(b -> sendScan(b.getRawValue()))
                    .addOnFailureListener(e -> Toast.makeText(this, "The scanner is not available on this phone. Type the address and code instead.", Toast.LENGTH_LONG).show());
        } catch (Throwable t) {
            Toast.makeText(this, "The scanner is not available on this phone. Type the address and code instead.", Toast.LENGTH_LONG).show();
        }
    }

    void sendScan(String txt) {
        if (txt == null) return;
        String js = "window.ITScanResult&&window.ITScanResult(" + JSONObject.quote(txt) + ")";
        web.evaluateJavascript(js, null);
    }

    void askSaveOrShare(final String name, final String mime, final byte[] bytes) {
        new AlertDialog.Builder(this)
                .setTitle(name)
                .setItems(new CharSequence[]{"Save to this device", "Share (WhatsApp, email, Drive…)"}, (d, which) -> {
                    if (which == 0) saveAs(name, mime, bytes);
                    else share(name, mime, bytes);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    String mimeFor(String name, String mime) {
        String n = name.toLowerCase();
        if (n.endsWith(".stt")) return "application/octet-stream";
        if (mime == null || mime.isEmpty()) return "application/octet-stream";
        return mime;
    }

    void saveAs(String name, String mime, byte[] bytes) {
        pendingBytes = bytes;
        pendingName = name;
        Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType(mimeFor(name, mime));
        i.putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(i, REQ_SAVE);
        } catch (ActivityNotFoundException e) {
            pendingBytes = null;
            share(name, mime, bytes);
        }
    }

    void share(String name, String mime, byte[] bytes) {
        try {
            File dir = new File(getCacheDir(), "shared");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("no space for the file");
            File f = new File(dir, safeName(name));
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(bytes);
            }
            Uri u = FileProvider.getUriForFile(this, getPackageName() + ".files", f);
            Intent i = new Intent(Intent.ACTION_SEND);
            i.setType(mimeFor(name, mime));
            i.putExtra(Intent.EXTRA_STREAM, u);
            i.putExtra(Intent.EXTRA_SUBJECT, name);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(i, "Share " + name));
        } catch (Exception e) {
            toast("Could not share the file: " + e.getMessage());
        }
    }

    String safeName(String n) {
        String s = n.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return s.isEmpty() ? "file" : s;
    }

    void doPrint(String title) {
        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
        if (pm == null) {
            toast("Printing is not available on this device");
            return;
        }
        String job = (title == null || title.isEmpty()) ? "Infinity Timetable" : title;
        final PrintDocumentAdapter inner = web.createPrintDocumentAdapter(job);
        // Pass everything through, and tell the page when printing is over so it can tidy up.
        PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
            @Override
            public void onStart() {
                inner.onStart();
            }

            @Override
            public void onLayout(PrintAttributes oldA, PrintAttributes newA, CancellationSignal cancel,
                                 LayoutResultCallback cb, Bundle extras) {
                inner.onLayout(oldA, newA, cancel, cb, extras);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor dest, CancellationSignal cancel,
                                WriteResultCallback cb) {
                inner.onWrite(pages, dest, cancel, cb);
            }

            @Override
            public void onFinish() {
                inner.onFinish();
                web.evaluateJavascript("window.dispatchEvent(new Event('afterprint'))", null);
            }
        };
        pm.print(job, adapter, new PrintAttributes.Builder().build());
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            toast("No app on this device can open that link");
        }
    }

    void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] picked = null;
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    picked = new Uri[n];
                    for (int k = 0; k < n; k++) picked[k] = data.getClipData().getItemAt(k).getUri();
                } else if (data.getData() != null) {
                    picked = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(picked);
            fileCallback = null;
            return;
        }
        if (request == REQ_SAVE) {
            if (result == RESULT_OK && data != null && data.getData() != null && pendingBytes != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData(), "wt")) {
                    if (out == null) throw new Exception("the folder could not be opened");
                    out.write(pendingBytes);
                    toast("Saved " + pendingName);
                } catch (Exception e) {
                    toast("Could not save: " + e.getMessage());
                }
            }
            pendingBytes = null;
            return;
        }
        super.onActivityResult(request, result, data);
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.ITBack?ITBack():false)", v -> {
            if (!"true".equals(v)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        super.onPause();
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
