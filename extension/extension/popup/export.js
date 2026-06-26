document.getElementById('printBtn').addEventListener('click', function() {
  var frame = document.getElementById('reportFrame');
  if (frame && frame.contentWindow) {
    frame.contentWindow.print();
  } else {
    window.print();
  }
});

chrome.storage.local.get(['_gapExportHtml'], function(result) {
  var html = result._gapExportHtml;
  var loading = document.getElementById('loading');
  var frame = document.getElementById('reportFrame');

  if (!html) {
    loading.textContent = 'Error: No report data found. Please try again from the extension.';
    return;
  }

  chrome.storage.local.remove(['_gapExportHtml']);

  // Write the report HTML into the iframe via srcdoc (no CSP issues)
  frame.srcdoc = html;
  frame.style.display = 'block';
  loading.style.display = 'none';

  // Auto-resize iframe to content height once loaded
  frame.addEventListener('load', function() {
    try {
      var h = frame.contentDocument.body.scrollHeight;
      frame.style.height = (h + 40) + 'px';
    } catch(e) {}
  });
});
