import { describe, expect, it } from "vitest";
import {
  compileRule, inferRule, inferRuleFromResponses, inferTextRule, isStatusOnlyRule, ruleHash, suggestPhrase, withRequiredPhrase,
  type RuleDefinition, type UpstreamResult,
} from "../src/index";

const res = (body: string, contentType: string, status = 200): UpstreamResult => ({ status, contentType, body, latencyMs: 1 });
const ERROR = ["/ looks like an error response"];

const NGINX_502 = "<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.25.3</center>\r\n</body>\r\n</html>\r\n";
const APACHE_404 = '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html><head>\n<title>404 Not Found</title>\n</head><body>\n<h1>Not Found</h1>\n<p>The requested URL was not found on this server.</p>\n</body></html>\n';
const CLOUDFLARE_522 = '<!DOCTYPE html>\n<html lang="en-US">\n<head>\n<title>example.com | 522: Connection timed out</title>\n<meta charset="UTF-8" />\n</head>\n<body><div id="cf-wrapper"><h1>Connection timed out</h1><span>Error code 522</span></div></body>\n</html>';
const VERCEL_404 = '<!DOCTYPE html><html><head><meta charSet="utf-8"/><title>404: This page could not be found</title></head><body><div><h1>404</h1><h2>This page could not be found.</h2></div></body></html>';
const VERCEL_500 = '<!DOCTYPE html><html lang="en"><head><title>500: INTERNAL_SERVER_ERROR</title></head><body><p>A server error has occurred</p><p>FUNCTION_INVOCATION_FAILED</p></body></html>';
const HEROKU = '<!DOCTYPE html>\n<html>\n  <head>\n    <meta name="viewport" content="width=device-width, initial-scale=1">\n    <meta charset="utf-8">\n    <title>Application Error</title>\n    <style media="screen">html,body{margin:0}</style>\n  </head>\n  <body>\n    <iframe src="//www.herokucdn.com/error-pages/application-error.html"></iframe>\n  </body>\n</html>';
const EXPRESS = '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /prices</pre>\n</body>\n</html>\n';
const FLASK_404 = "<!doctype html>\n<html lang=en>\n<title>404 Not Found</title>\n<h1>Not Found</h1>\n<p>The requested URL was not found on the server. If you entered the URL manually please check your spelling and try again.</p>\n";
const WERKZEUG = '<!doctype html>\n<html lang=en>\n  <head>\n    <title>ZeroDivisionError: division by zero\n // Werkzeug Debugger</title>\n  </head>\n  <body style="background-color: #fff">\n    <div class="debugger">\n<h1>ZeroDivisionError</h1>\n<h2 class="traceback">Traceback <em>(most recent call last)</em></h2>\n</div></body></html>';
const DJANGO = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta http-equiv="content-type" content="text/html; charset=utf-8">\n  <meta name="robots" content="NONE,NOARCHIVE">\n  <title>OperationalError\n          at /prices/</title>\n</head>\n<body>\n<div id="summary">\n  <h1>OperationalError\n       at /prices/</h1>\n  <pre class="exception_value">no such table: prices</pre>\n</div>\n<textarea id="traceback_area">Environment:\n\nTraceback (most recent call last):\n  File "/app/views.py", line 12, in prices\n</textarea>\n</body>\n</html>';
const RAILS = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <title>Action Controller: Exception caught</title>\n</head>\n<body>\n<header><h1>NoMethodError in PricesController#index</h1></header>\n<div id="container"><h2>undefined method `price\' for nil:NilClass</h2></div>\n</body>\n</html>';
const RAILS_PROD = '<!DOCTYPE html>\n<html>\n<head>\n  <title>We\'re sorry, but something went wrong (500)</title>\n</head>\n<body class="rails-default-error-page">\n  <div class="dialog"><h1>We\'re sorry, but something went wrong.</h1></div>\n</body>\n</html>';
const IIS = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<title>IIS 10.0 Detailed Error - 404.0 - Not Found</title>\n</head>\n<body><div id="content"><h3>HTTP Error 404.0 - Not Found</h3></div></body></html>';
const PYTHON_TRACE = 'Traceback (most recent call last):\n  File "/app/main.py", line 42, in get_price\n    return PRICES[symbol]\nKeyError: \'XYZ\'\n';
const LOGGED_PYTHON_TRACE = `price service log\n${"request ok\n".repeat(30)}Traceback (most recent call last):\n  File "/app/main.py", line 42, in get_price\nKeyError: 'XYZ'\n`;
const JAVA_TRACE = 'java.lang.NullPointerException: Cannot invoke "String.length()" because "s" is null\n\tat com.example.prices.PriceService.lookup(PriceService.java:27)\n\tat com.example.prices.PriceController.get(PriceController.java:15)\n';
const JAVA_THREAD = 'Exception in thread "main" java.lang.IllegalStateException: no prices\n\tat Main.main(Main.java:5)\n';
const NODE_TRACE = "TypeError: Cannot read properties of undefined (reading 'price')\n    at getPrice (/app/src/prices.js:12:20)\n    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)\n";
const NODE_TRACE_IN_REPORT = `ADA 0.35\nBTC 62000\nsomething broke\n    at Object.<anonymous> (/app/index.js:3:9)\n    at Module._compile (node:internal/modules/cjs/loader:1256:14)\n`;
const DOTNET_TRACE = "System.InvalidOperationException: Sequence contains no elements\n   at System.Linq.ThrowHelper.ThrowNoElementsException()\n   at Prices.Api.PriceService.Get(String symbol) in C:\\src\\Prices\\PriceService.cs:line 42\n";
const GO_PANIC = "panic: runtime error: index out of range [3] with length 3\n\ngoroutine 1 [running]:\nmain.main()\n\t/tmp/sandbox/prog.go:8 +0x1d\nexit status 2\n";
const GO_PANIC_LATE = `price,symbol\n0.35,ADA\npanic: runtime error: invalid memory address or nil pointer dereference\n[signal SIGSEGV]\n\ngoroutine 7 [running]:\n`;
const RUBY_TRACE = "prices.rb:12:in `fetch': undefined method `price' for nil:NilClass (NoMethodError)\n\tfrom prices.rb:20:in `<main>'\n";
const PHP_FATAL = "PHP Fatal error:  Uncaught Exception: no price in /var/www/price.php:7\nStack trace:\n#0 {main}\n  thrown in /var/www/price.php on line 7\n";
const PHP_HTML_FATAL = "<br />\n<b>Fatal error</b>:  Uncaught Error: Call to undefined function price() in /var/www/index.php:3\nStack trace:\n#0 {main}\n  thrown in <b>/var/www/index.php</b> on line <b>3</b><br />\n";
const LONG_RATE_LIMIT = `Rate limit exceeded. You have made too many requests in the last minute. ${"Please wait before trying again and consider upgrading your plan for a higher limit. ".repeat(4)}`;
const LONG_TOO_MANY = `Too Many Requests\n\n${"Your client has sent too many requests to this endpoint and has been throttled for a while. ".repeat(3)}`;
const LONG_ERROR = `Error: connect ECONNREFUSED 127.0.0.1:5432\n${"while fetching the latest prices from the database for the requested symbol list. ".repeat(3)}`;
const LONG_404 = `404 Not Found\n\n${"The requested resource could not be found on this server, check the path and try again later. ".repeat(3)}`;
const HTTP_DUMP = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: 21\r\n\r\nsomething broke badly";
const HTTP_DUMP_LONG = `\n\nHTTP/2 503\nretry-after: 30\n\n${"upstream is overloaded please wait; ".repeat(8)}`;
const SPRING_JSON = '{"timestamp":"2026-10-07T12:00:00.000+00:00","status":500,"error":"Internal Server Error","path":"/prices"}';
const GRAPHQL_JSON = '{"data":null,"errors":[{"message":"Cannot query field \\"prise\\" on type \\"Query\\".","locations":[{"line":1,"column":3}]}]}';
const NESTED_ERROR_JSON = '{"meta":{"requestId":"abc","region":{"name":"eu"}},"error":{"code":429,"message":"Too many requests, slow down"}}';
const MESSAGE_STATUS_JSON = '{"message":"No price for symbol XYZ in any of the venues we track, try again with a listed symbol","statusCode":404}';
const SOAP_11 = '<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">\n  <soap:Body>\n    <soap:Fault>\n      <faultcode>soap:Server</faultcode>\n      <faultstring>Price lookup failed for the requested symbol list because the backend did not answer in time</faultstring>\n    </soap:Fault>\n  </soap:Body>\n</soap:Envelope>';
const SOAP_12_DEFAULT_NS = '<Envelope xmlns="http://www.w3.org/2003/05/soap-envelope"><Body><Fault><Code><Value>Receiver</Value></Code><Reason><Text xml:lang="en">The price service is not available right now, please retry later on</Text></Reason></Fault></Body></Envelope>';
const XML_ERROR = '<?xml version="1.0"?>\n<error>\n  <code>RateLimited</code>\n  <message>You have sent too many requests in a short time, please slow down and retry after a minute or two.</message>\n</error>';
const XML_AWS = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- generated -->\n<Error><Code>NoSuchKey</Code><Message>The specified key does not exist in this bucket, check the name and try again.</Message><Key>prices.xml</Key><RequestId>4442587FB7D0A2F9</RequestId></Error>';
const XML_ERROR_RESPONSE = '<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>Throttling</Code><Message>Rate exceeded for this account, please back off and retry the request later on</Message></Error></ErrorResponse>';
const XML_ERRORS_ROOT = '<errors><error field="symbol">Unknown symbol XYZ, it is not one of the symbols this feed publishes today</error></errors>';
const XML_NS_EXCEPTION = '<ns2:exception xmlns:ns2="urn:x"><ns2:message>Database connection pool exhausted while reading the price table for this request</ns2:message></ns2:exception>';

const LONG = (start: string) => `${start}${"The price service could not answer this request for the symbol you asked about. ".repeat(3)}`;
const CHALLENGE = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><p>price ${"Please wait while we check your browser. ".repeat(6)}</p></body></html>`;
const DOC_PAGE = (title: string) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><h1>${title}</h1>${"<p>Some reference text about prices.</p>".repeat(8)}</body></html>`;

/** Error bodies sent with status 200: every promise refuses them, whatever its media type. */
const ERROR_PAGES: Array<[string, string, string]> = [
  ["nginx 502 page", "text/plain", NGINX_502],
  ["nginx 502 page", "text/html", NGINX_502],
  ["Apache 404 page", "text/csv", APACHE_404],
  ["Apache 404 page", "text/html", APACHE_404],
  ["Cloudflare 522 page", "text/html", CLOUDFLARE_522],
  ["Cloudflare 522 page", "text/plain", CLOUDFLARE_522],
  ["Vercel 404 page", "text/html", VERCEL_404],
  ["Vercel 500 page", "text/html", VERCEL_500],
  ["Heroku application error", "text/html", HEROKU],
  ["Heroku application error", "text/csv", HEROKU],
  ["Express Cannot GET page", "text/html", EXPRESS],
  ["Express Cannot GET text", "text/plain", "Cannot GET /prices"],
  ["Flask 404 page", "text/html", FLASK_404],
  ["Werkzeug debugger", "text/html", WERKZEUG],
  ["Django debug page", "text/html", DJANGO],
  ["Django debug page", "application/xml", DJANGO],
  ["Rails debug page", "text/html", RAILS],
  ["Rails production 500 page", "text/html", RAILS_PROD],
  ["IIS detailed error", "text/html", IIS],
  ["Python traceback", "text/plain", PYTHON_TRACE],
  ["Python traceback after log lines", "text/plain", LOGGED_PYTHON_TRACE],
  ["Python traceback", "application/xml", PYTHON_TRACE],
  ["Java stack trace", "text/plain", JAVA_TRACE],
  ["Java thread exception", "text/csv", JAVA_THREAD],
  ["Node stack trace", "text/plain", NODE_TRACE],
  ["Node stack trace after data", "text/plain", NODE_TRACE_IN_REPORT],
  ["Node stack trace", "text/html", NODE_TRACE],
  [".NET stack trace", "text/plain", DOTNET_TRACE],
  ["Go panic", "text/plain", GO_PANIC],
  ["Go panic after CSV rows", "text/csv", GO_PANIC_LATE],
  ["Ruby backtrace", "text/plain", RUBY_TRACE],
  ["PHP fatal error", "text/plain", PHP_FATAL],
  ["PHP fatal error in HTML", "text/html", PHP_HTML_FATAL],
  ["plain Error:", "text/plain", "Error: symbol XYZ is not supported"],
  ["plain ERROR code", "text/plain", `ERROR 1045 (28000): Access denied for user 'prices'@'localhost' (using password: YES)\n${"x".repeat(200)}`],
  ["exception name", "text/plain", `KeyError: 'XYZ'\n${"detail ".repeat(40)}`],
  ["long rate-limit message", "text/plain", LONG_RATE_LIMIT],
  ["long rate-limit message", "text/csv", LONG_RATE_LIMIT],
  ["long Too Many Requests", "text/plain", LONG_TOO_MANY],
  ["long Error: message", "text/plain", LONG_ERROR],
  ["long 404 text", "text/plain", LONG_404],
  ["long Service Unavailable", "text/plain", `Service Unavailable: ${"the server is temporarily unable to service your request. ".repeat(5)}`],
  ["HTTP response dump", "text/plain", HTTP_DUMP],
  ["HTTP/2 status line", "text/plain", HTTP_DUMP_LONG],
  ["HTTP status line", "application/xml", HTTP_DUMP],
  ["Spring JSON error in text/plain", "text/plain", SPRING_JSON],
  ["GraphQL errors in text/plain", "text/plain", GRAPHQL_JSON],
  ["nested-then-error JSON in text/csv", "text/csv", NESTED_ERROR_JSON],
  ["message and status JSON", "text/plain", MESSAGE_STATUS_JSON],
  ["JSON fault", "text/plain", '{"fault":{"faultstring":"Rate limit quota violation. Quota limit exceeded for this application, try again later.","detail":{"errorcode":"policies.ratelimit.QuotaViolation"}}}'],
  ["JSON error", "application/xml", SPRING_JSON],
  ["SOAP 1.1 fault", "application/xml", SOAP_11],
  ["SOAP 1.1 fault", "text/xml", SOAP_11],
  ["SOAP 1.2 fault without prefix", "application/soap+xml", SOAP_12_DEFAULT_NS],
  ["XML <error>", "application/xml", XML_ERROR],
  ["S3 <Error>", "application/xml", XML_AWS],
  ["IAM <ErrorResponse>", "application/xml", XML_ERROR_RESPONSE],
  ["XML <errors> root", "application/xml", XML_ERRORS_ROOT],
  ["namespaced <exception> root", "text/xml", XML_NS_EXCEPTION],
  ["XML error", "text/plain", XML_ERROR.replace('<?xml version="1.0"?>\n', "")],
  ["long Error in ...", "text/plain", LONG("Error in price lookup. ")],
  ["long Exception occurred", "text/plain", LONG("Exception occurred while getting price. ")],
  ["long Fatal exception", "text/plain", LONG("Fatal exception in price worker. ")],
  ["long Error then two spaces", "text/plain", LONG("Error  The upstream did not answer. ")],
  // The whole word Error starts an error at any length, as it does under 200 characters (ERROR_BODY).
  ["a long report starting with Error rates", "text/plain", `Error rates by region\n${"eu,0.1\n".repeat(40)}`],
  ["long guarded phrase with a colon", "text/plain", LONG("Server error: the database is down. ")],
  ["HTML after a comment", "text/plain", `<!-- generated -->\n${NGINX_502}`],
  ["XHTML after an XML declaration", "text/plain", `<?xml version="1.0" encoding="UTF-8"?>\n${IIS}`],
  ["Cloudflare challenge", "text/html", CHALLENGE("Just a moment...")],
  ["Cloudflare block", "text/html", CHALLENGE("Attention Required! | Cloudflare")],
  ["maintenance page", "text/html", CHALLENGE("Site Maintenance")],
  ["page not found after the site name", "text/html", CHALLENGE("Example - Page not found")],
  ["error title before the site name", "text/html", CHALLENGE("Error | Example")],
  ["XML root with status error", "application/xml", `<?xml version="1.0"?><quote status="error"><message>${"no price for this symbol ".repeat(8)}</message></quote>`],
  ["XML root with stat fail", "application/xml", '<rsp stat="fail"><err code="1" msg="Symbol not found in any of the venues we track, check it and try again"/></rsp>'],
  ["XML first child status error", "application/xml", `<response><status>error</status><message>${"the price feed is down ".repeat(8)}</message></response>`],
];

const CSV_ERROR_COUNTS = "date,service,error_count,errors\n2026-10-01,api,0,0\n2026-10-02,api,3,3\n";
const REPORT = `Daily price report\n\n${"ADA closed at 0.35 USD, up 2 percent on volume of 1.2 million. No errors were reported by the venues.\n".repeat(4)}`;
const HTML_LISTING = '<!DOCTYPE html>\n<html lang="en">\n<head><meta charset="utf-8"><title>ADA price today</title></head>\n<body><h1>Cardano (ADA)</h1><table><tr><th>Price</th><td>0.35</td></tr><tr><th>Errors</th><td>0</td></tr></table></body>\n</html>';
const HTML_ERROR_DOCS = `<!DOCTYPE html><html><head><title>Error rates by region</title></head><body><h2>Error rates</h2>${"<p>eu 0.1%</p><p>us 0.2%</p>".repeat(6)}</body></html>`;
const HTML_EXCEPTIONS_GUIDE = '<html><head><title>Handling exceptions in price feeds</title></head><body><p>When a venue times out we fall back to the last price.</p></body></html>';
const SVG_IN_HTML = `<html><body><svg><title>Error budget used</title><rect width="10" height="10"/></svg>${"<p>Budget 12%</p>".repeat(12)}</body></html>`;
const XML_PRICES = '<?xml version="1.0" encoding="UTF-8"?>\n<prices updated="2026-10-07T12:00:00Z">\n  <price symbol="ADA">0.35</price>\n  <price symbol="BTC">62000</price>\n</prices>';
const XML_WITH_EMPTY_ERRORS = '<?xml version="1.0"?><result><errors/><items><item>ADA 0.35</item></items></result>';
const XML_STATUS = '<status><service name="prices" errors="0" faults="0">ok</service></status>';
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Error handling news</title>${"<item><title>500 new listings</title></item>".repeat(4)}</channel></rss>`;
const PRICE_JSON_TEXT = '{"symbol":"ADA","price":0.35,"status":"ok"}';
const JSON_NESTED_ERROR_FIELD = '{"symbol":"ADA","checks":{"error":null,"stale":false},"price":0.35}';

/** Ordinary answers: every promise of their type keeps them. */
const GOOD_ANSWERS: Array<[string, string, string]> = [
  ["a price", "text/plain", "ADA 0.35"],
  ["a CSV with error_count and errors columns", "text/csv", CSV_ERROR_COUNTS],
  // A CSV under 200 characters whose first column is "error" is still refused by the short error-text check (ERROR_BODY).
  ["a CSV whose first column is error", "text/csv", `error,count\n${"timeout,3\nrefused,1\n".repeat(12)}`],
  ["a CSV whose first column is errors", "text/csv", "errors;warnings\n0;2\n"],
  ["0 errors found", "text/plain", "Scan complete: 0 errors found in 120 files."],
  ["error mid-sentence", "text/plain", `The feed had no error today. ${"ADA 0.35 BTC 62000. ".repeat(20)}`],
  ["Errors: 0", "text/plain", "Errors: 0\nWarnings: 2\n"],
  ["error_count=0", "text/plain", "error_count=0 latency_ms=12"],
  ["a report", "text/plain", REPORT],
  ["a report starting with Server error rate", "text/plain", LONG("Server error rate: 0.1%\n")],
  ["a report starting with Access denied events", "text/plain", LONG("Access denied events: 4\n")],
  ["a report starting with Bad request ratio", "text/plain", LONG("Bad request ratio 0.2\n")],
  ["a report starting with Failed to deliver", "text/plain", LONG("Failed to deliver: 0 parcels\n")],
  ["a search answer starting with Unable to find", "text/plain", LONG("Unable to find a cheaper fare today.\n")],
  ["prose starting with Could not", "text/plain", LONG("Could not be happier with the results.\n")],
  ["prose starting with Traceback", "text/plain", LONG("Traceback is a word for a fishing line.\n")],
  ["a log summary starting with Server error logs", "text/plain", "Server error logs for host a\n500 lines\n"],
  ["a sentence quoting a 200 status line", "text/plain", LONG("HTTP/1.1 200 OK is the status line.\n")],
  ["a CSV with a hyphenated first column", "text/csv", `error-free,days\n${"yes,3\n".repeat(40)}`],
  ["a report with a Not found row", "text/csv", "symbol,status\nADA,listed\nXYZ,Not Found\n"],
  ["a status word list", "text/plain", "Status words: ok, degraded, down\n"],
  ["a timeout setting", "text/plain", `timeout_seconds=30\n${"retry=3\n".repeat(30)}`],
  ["markdown", "text/markdown", "# ADA\n\nPrice **0.35** USD.\n\n- 24h change: +2%\n"],
  ["YAML", "application/yaml", "symbol: ADA\nprice: 0.35\nerrors: []\n"],
  ["a JSON price as text", "text/plain", PRICE_JSON_TEXT],
  ["JSON with a nested error field as text", "text/plain", JSON_NESTED_ERROR_FIELD],
  ["JSON with message and data as text", "text/plain", '{"message":"ok","status":200,"price":0.35}'],
  ["a JSON array as text", "text/plain", '[{"error":"none"}]'],
  ["prose mentioning Java", "text/plain", "We moved from java.lang.String parsing to a faster decoder.\n"],
  ["prose mentioning goroutines", "text/plain", "Each goroutine fetches one venue and the results are merged.\n"],
  ["indented prose with at", "text/plain", "Schedule:\n    at noon the prices refresh (daily)\n    at midnight the report is sent\n"],
  ["a sentence with Fatal in it", "text/plain", "Fatality rates fell in 2026 across all regions.\n"],
  ["an HTML listing", "text/html", HTML_LISTING],
  ["an HTML page titled Error rates", "text/html", HTML_ERROR_DOCS],
  ["an HTML guide on exceptions", "text/html", HTML_EXCEPTIONS_GUIDE],
  ["an SVG title inside HTML", "text/html", SVG_IN_HTML],
  ["an HTML fragment", "text/html", "<h1>Prices</h1><p>ADA 0.35</p>"],
  ...[
    "TypeError - JavaScript | MDN", "How to fix 500 Internal Server Error | Blog", "Something went wrong? Our refund policy",
    "Server error rates | Monitor", "Dashboard | Error: none", "Unable to sleep? Tips", "FooException docs", "KeyError reference",
    "Hotel ratings: Access denied to pets?", "Python - Fatal: what it means", "Pool maintenance tips", "Built-in Exceptions",
  ].map((t): [string, string, string] => [`a docs page titled ${t}`, "text/html", DOC_PAGE(t)]),
  ["XML whose root has a data-status attribute", "application/xml", '<response data-status="error"><item>ADA 0.35</item></response>'],
  ["XML whose first child status is ok", "application/xml", "<response><status>ok</status><item>ADA 0.35</item></response>"],
  ["XML prices", "application/xml", XML_PRICES],
  ["XML with an empty <errors/> inside data", "application/xml", XML_WITH_EMPTY_ERRORS],
  ["XML with errors attributes", "text/xml", XML_STATUS],
  ["an RSS feed", "application/rss+xml", RSS],
  ["XML with a <fault> element inside data", "application/xml", "<grid><line id=\"7\"><fault>none</fault></line></grid>"],
  ["Atom with an error entry title", "application/atom+xml", '<feed xmlns="http://www.w3.org/2005/Atom"><title>Status</title><entry><title>Error budget report</title></entry></feed>'],
];

const ruleFor = (contentType: string) => compileRule(inferTextRule(contentType, ["x"]));

describe("every text promise refuses error pages and error messages sent with 200", () => {
  it(`has at least 40 error bodies and 30 good answers (${ERROR_PAGES.length} and ${GOOD_ANSWERS.length})`, () => {
    expect(ERROR_PAGES.length).toBeGreaterThanOrEqual(40);
    expect(GOOD_ANSWERS.length).toBeGreaterThanOrEqual(30);
  });

  it.each(ERROR_PAGES)("refuses %s as %s", (_name, contentType, body) => {
    expect(ruleFor(contentType).check(res(body, contentType)).reasons).toEqual(ERROR);
  });

  it.each(ERROR_PAGES)("refuses %s as %s under a promise with a required phrase the page happens to contain", (_name, contentType, body) => {
    const word = /[A-Za-z]{3,}/.exec(body)![0];
    expect(compileRule(withRequiredPhrase(inferTextRule(contentType, ["x"]), word)).check(res(body, contentType)).reasons).toEqual(ERROR);
  });

  it.each(GOOD_ANSWERS)("keeps %s as %s", (_name, contentType, body) => {
    expect(ruleFor(contentType).check(res(body, contentType))).toEqual({ pass: true, reasons: [] });
  });

  it("a JSON listing refuses each error object too (all but the text-only ones)", () => {
    const rule = compileRule(inferRuleFromResponses([res('{"symbol":"ADA","price":0.35}', "application/json")]));
    for (const body of [SPRING_JSON, GRAPHQL_JSON, '{"symbol":"ADA","price":0.35,"error":"stale"}', '{"symbol":"ADA","price":0.35,"exception":{}}']) {
      expect(rule.check(res(body, "application/json")).pass, body).toBe(false);
    }
  });

  it("an error body with a 2xx status other than 200 is refused too", () => {
    expect(ruleFor("text/plain").check(res(LONG_RATE_LIMIT, "text/plain", 203)).reasons).toEqual(ERROR);
  });

  it("does not take long on a large body or one built to backtrack", () => {
    const rule = ruleFor("text/plain");
    const bodies = [
      `{${'"a":[1,{"b":[2,{"c":"d"}]}],'.repeat(20_000)}"z":1}`,
      `{${"[".repeat(5_000)}`,
      `{"message":"${"x".repeat(100_000)}"`,
      `${"    at ".repeat(20_000)}`,
      `<title>${"| ".repeat(50_000)}`,
      `<?x?>${"<!--".repeat(20_000)}`,
      "price list\n".repeat(50_000),
      `x\n  at ${"/".repeat(1_000_000)}`,
      `x\n  at ${"a/".repeat(500_000)}`,
      `  at a(${") in ".repeat(200_000)}`,
      `${"<!--a-->".repeat(100_000)}y`,
      `<a${' b="c"'.repeat(150_000)}`,
      `<a${" status".repeat(150_000)}`,
      `<title>${"Error ".repeat(150_000)}`,
      `<title>${"a - ".repeat(200_000)}`,
      `java.lang.${"a".repeat(1_000_000)}`,
    ];
    const t0 = performance.now();
    for (const b of bodies) rule.check(res(b, "text/plain"));
    for (const b of bodies) ruleFor("application/xml").check(res(b, "application/xml"));
    expect(performance.now() - t0).toBeLessThan(3_000);
  });

  it("reads a body of repeated tag starts in linear time, up to the 1 MB answer cap", () => {
    const seeds = ["<body", "<title ", "<body ", "<x:body", "<title>", "<body>", "<soap:Body>", "<a>", "<!--", "\n  at ", "<code>500</code>"];
    for (const contentType of ["text/plain", "text/html", "application/xml"]) {
      const rule = ruleFor(contentType);
      for (const size of [200_000, 1_000_000]) {
        for (const seed of seeds) {
          const body = seed.repeat(Math.ceil(size / seed.length));
          // The best of two runs, so a pause of the test machine does not count. About 35 ms at 1 MB on a laptop.
          const ms = Math.min(...[0, 1].map(() => {
            const t0 = performance.now();
            rule.check(res(body, contentType));
            return performance.now() - t0;
          }));
          expect(ms, `${contentType} ${JSON.stringify(seed)} x ${size}`).toBeLessThan(100);
        }
      }
    }
  });
});

describe("a markup listing with a required phrase still refuses an error page with no error title or root", () => {
  // Past the short-error check (ERROR_BODY_MAX_LENGTH), so only the long checks decide.
  const pad = `<p>Prices</p>${"<p>row</p>".repeat(20)}`;
  const ruleWithPhrase = (contentType: string) => compileRule(withRequiredPhrase(inferTextRule(contentType, [`Prices ${pad}`]), "Prices"));
  const refused: [string, string][] = [
    ["text/html", `<!doctype html><html><head><title>Example Prices</title></head><body><h1>Internal Server Error</h1>${pad}</body></html>`],
    ["text/html", `<html><head><title>Prices</title><style>body{}</style></head><body class="x"><div><h1>500 Internal Server Error</h1></div>${pad}</body></html>`],
    ["text/html", `<html><body><pre>HTTP/1.1 503 Service Unavailable\nRetry-After: 30</pre>${pad}</body></html>`],
    ["text/html", `<html><body><p>Error: price lookup failed</p>${pad}</body></html>`],
    ["text/html", `<html><body><h2>Something went wrong.</h2>${pad}</body></html>`],
    ["application/xml", `<?xml version="1.0"?><response><code>500</code><message>Prices unavailable</message><detail>${"x".repeat(200)}</detail></response>`],
    ["application/xml", `<response>\n  <status>503</status>\n  <error>Service Unavailable</error>\n  <requestId>${"a".repeat(200)}</requestId>\n  <message>Prices</message>\n</response>`],
    ["application/xml", `<Result><statusCode>404</statusCode><detail>Prices: no such symbol ${"x".repeat(200)}</detail></Result>`],
  ];
  it.each(refused)("%s %#", (contentType, body) => {
    expect(ruleWithPhrase(contentType).check(res(body, contentType))).toEqual({ pass: false, reasons: ERROR });
  });

  const kept: [string, string][] = [
    ["text/html", `<html><head><title>Example Prices</title></head><body><h1>Forbidden City visitor report</h1>${pad}</body></html>`],
    ["text/html", `<html><body><table><tr><td>404</td><td>Prices</td></tr></table>${pad}</body></html>`],
    ["text/html", `<html><body><h1>Error rates by region</h1>${pad}</body></html>`],
    ["text/html", `<html><body><h1>Prices</h1><p>Error: none</p>${pad}</body></html>`],
    ["application/xml", `<response><code>500</code><message>Prices</message><items>${"<item>1</item>".repeat(20)}</items></response>`],
    ["application/xml", `<prices>${'<price symbol="ADA">0.35</price>'.repeat(10)}<status>500</status><note>Prices</note></prices>`],
    ["application/xml", `<feed><title>Prices</title>${"<entry><title>Error handling guide</title></entry>".repeat(5)}</feed>`],
    ["application/xml", `<response><code>500</code><count>3</count><message>Prices ${"x".repeat(200)}</message></response>`],
  ];
  it.each(kept)("keeps %s %#", (contentType, body) => {
    expect(ruleWithPhrase(contentType).check(res(body, contentType))).toEqual({ pass: true, reasons: [] });
  });
});

describe("promises stored before these checks", () => {
  // The stored HTML check, as written by the previous release: new promises use one that also skips a leading comment.
  const STORED_HTML_PAGE = "^\\s*<(?:![Dd][Oo][Cc][Tt][Yy][Pp][Ee]\\s+[Hh][Tt][Mm][Ll]|[Hh][Tt][Mm][Ll]|(?:[Hh]1|[Tt][Ii][Tt][Ll][Ee]|[Bb][Oo][Dd][Yy]|[Hh][Ee][Aa][Dd])(?=[\\s>/]))";
  const legacyNot = (contentType: string) => {
    const not = inferTextRule(contentType, ["x"]).schema.not as { anyOf: unknown[] };
    return { anyOf: contentType === "text/html" ? not.anyOf.slice(0, 1) : [{ pattern: STORED_HTML_PAGE }, not.anyOf[1]] };
  };
  const legacy: RuleDefinition = {
    version: 1, status: { min: 200, max: 299 }, contentType: "text/plain",
    schema: { type: "string", minLength: 1, pattern: "\\S", not: legacyNot("text/plain") },
  };

  it("compile and behave as before: a long error message still passes the old definition, with the old hash", () => {
    const hash = ruleHash(legacy);
    const rule = compileRule(legacy);
    expect(rule.hash).toBe(hash);
    expect(rule.check(res(LONG_RATE_LIMIT, "text/plain")).pass).toBe(true);
    expect(rule.check(res(PYTHON_TRACE, "text/plain")).pass).toBe(true);
    expect(rule.check(res("Rate limit exceeded", "text/plain")).pass).toBe(false);
    expect(rule.check(res(NGINX_502, "text/plain")).pass).toBe(false);
    expect(ruleHash(legacy)).toBe(hash);
  });

  it("still read as status-only, as do new ones, for every media type", () => {
    expect(isStatusOnlyRule(legacy)).toBe(true);
    expect(isStatusOnlyRule({ ...legacy, contentType: "text/html", schema: { ...legacy.schema, not: legacyNot("text/html") } })).toBe(true);
    for (const ct of ["text/plain", "text/csv", "text/html", "application/xml"]) expect(isStatusOnlyRule(inferTextRule(ct, ["x"])), ct).toBe(true);
    expect(isStatusOnlyRule({ ...legacy, contentType: "text/csv", schema: { ...legacy.schema, not: legacyNot("text/html") } })).toBe(false);
  });

  it("an old JSON promise without the error keys still takes an answer with an error key", () => {
    const old: RuleDefinition = {
      version: 1, status: { min: 200, max: 299 }, contentType: "application/json",
      schema: { type: "object", required: ["price"], properties: { price: { type: "number" } } },
    };
    expect(compileRule(old).check(res('{"price":1,"error":"x"}', "application/json")).pass).toBe(true);
  });
});

describe("JSON promises refuse error keys no good answer had", () => {
  it("adds error, errors, exception and fault to not.anyOf, sorted with the error sample's own keys", () => {
    expect(inferRule([{ price: 1 }]).schema).toEqual({
      type: "object", required: ["price"], properties: { price: { type: "number" } },
      not: { anyOf: [{ required: ["error"] }, { required: ["errors"] }, { required: ["exception"] }, { required: ["fault"] }] },
    });
    expect((inferRule([{}], { message: "x" }).schema.not as { anyOf: unknown[] }).anyOf).toEqual([
      { required: ["error"] }, { required: ["errors"] }, { required: ["exception"] }, { required: ["fault"] }, { required: ["message"] },
    ]);
  });

  it("keeps a key the good answers had: an answer with errors: [] still passes", () => {
    const def = inferRule([{ data: [1], errors: [] }, { data: [2], errors: [] }]);
    expect((def.schema.not as { anyOf: unknown[] }).anyOf).toEqual([{ required: ["error"] }, { required: ["exception"] }, { required: ["fault"] }]);
    expect(compileRule(def).check(res('{"data":[3],"errors":[]}', "application/json")).pass).toBe(true);
  });

  it("checks only the top level, and leaves arrays and scalars alone", () => {
    const rule = compileRule(inferRule([{ price: 1, checks: { ok: true } }]));
    expect(rule.check(res('{"price":2,"checks":{"ok":true,"error":null}}', "application/json")).pass).toBe(true);
    expect(rule.check(res('{"price":2,"checks":{"ok":true},"error":null}', "application/json")).reasons).toEqual(ERROR);
    expect(inferRule([[1], [2]]).schema).toEqual({ type: "array", items: { type: "number" } });
    expect(inferRule([1]).schema).toEqual({ type: "number" });
  });
});

describe("suggestPhrase", () => {
  it("finds the longest phrase every good answer has and the bad answer lacks", () => {
    expect(suggestPhrase(["ADA price in USD: 0.35", "BTC price in USD: 62000"], "unknown symbol")).toBe("price in USD:");
    expect(suggestPhrase(["Daily price report\nADA 0.35\n", "Daily price report\nBTC 62000\n"])).toBe("Daily price report");
  });

  it("skips digits, line ends, tags and phrases the bad answer or error pages have", () => {
    expect(suggestPhrase(["symbol ADA last 0.35 venue binance", "symbol BTC last 62000 venue kraken"], "symbol XYZ last unknown venue none")).toBe(null);
    expect(suggestPhrase(["<h1>Cardano price</h1><p>0.35</p>", "<h1>Cardano price</h1><p>0.36</p>"])).toBe("Cardano price");
    expect(suggestPhrase(["Internal server status: green", "Internal server status: red"])).toBe("Internal");
    expect(suggestPhrase(["Not found: 0 items. Report ok", "Not found: 2 items. Report ok"])).toBe("items. Report ok");
    expect(suggestPhrase(["Price of ADA", "Price of BTC"], "PRICE OF nothing")).toBe(null);
  });

  it("keeps the phrase between 3 and 60 characters and prefers the earliest of equal ones", () => {
    const long = "the quick brown fox jumps over the lazy dog and keeps running far away";
    expect(suggestPhrase([`${long} 1`, `${long} 2`])!.length).toBeLessThanOrEqual(60);
    expect(suggestPhrase(["ab 1", "ab 2"])).toBe(null);
    expect(suggestPhrase(["alpha 1 gamma", "gamma 2 alpha"])).toBe("alpha");
    expect(suggestPhrase([])).toBe(null);
  });

  it("suggests nothing from one answer repeated: its words may belong to that one input", () => {
    const one = "Cardano (ADA) price today: 0.35 USD";
    expect(suggestPhrase([one, one, one, one, one], "unknown symbol")).toBe(null);
    expect(suggestPhrase([one, one, one, one, one, "Bitcoin (BTC) price today: 62000 USD"], "unknown symbol")).toBe("price today:");
  });

  it("gives a phrase that withRequiredPhrase takes and the good answers keep", () => {
    const good = ["Cardano (ADA) price: 0.35 USD", "Bitcoin (BTC) price: 62000 USD"];
    const phrase = suggestPhrase(good, "Error: unknown symbol")!;
    expect(phrase).toBe("price:");
    const rule = compileRule(withRequiredPhrase(inferTextRule("text/plain", good), phrase));
    for (const b of good) expect(rule.check(res(b, "text/plain")).pass).toBe(true);
  });

  it("is quick on a large CSV", () => {
    const rows = (n: number) => `symbol,price,venue name\n${Array.from({ length: 3000 }, (_, i) => `S${i},${i + n},Main venue`).join("\n")}`;
    const t0 = performance.now();
    expect(suggestPhrase([rows(1), rows(2), rows(3)])).toBe("symbol,price,venue name");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });
});
