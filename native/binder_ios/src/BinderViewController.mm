#import "BinderViewController.h"

#import <Network/Network.h>
#import <WebKit/WebKit.h>

#include "Backend.hpp"

static const NSInteger kMaxLoadRetries = 40;       // ~10 s at 250 ms apart: the server thread may not be accepting yet
static const NSTimeInterval kRetryDelay = 0.25;
static NSString* const kReleasesPrefix = @"https://github.com/MurderBot1/Cards/releases/";
static NSString* const kOpenHandlerName = @"binderOpen";
static NSString* const kSaveHandlerName = @"binderSave";   // { name, text }: an exported file, offered through the share sheet

@interface BinderViewController () <WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic, strong) WKWebView* webView;
@property(nonatomic, strong) UIView* loadingOverlay;
@property(nonatomic, strong) NSURL* serverURL;
@property(nonatomic) NSInteger loadAttempts;
@property(nonatomic) nw_path_monitor_t monitor;
@property(nonatomic) BOOL started;            // the backend has been started
@property(nonatomic) BOOL downloadHeld;       // started with the catalog download held back (waiting for Wi-Fi)
@end

@implementation BinderViewController

- (void)viewDidLoad {
    [super viewDidLoad];
    UIColor* background = [UIColor colorWithRed:0x12 / 255.0 green:0x13 / 255.0 blue:0x19 / 255.0 alpha:1];
    self.view.backgroundColor = background;

    WKWebViewConfiguration* config = [[WKWebViewConfiguration alloc] init];
    config.allowsInlineMediaPlayback = YES;                       // the scan preview plays inside the page
    config.mediaTypesRequiringUserActionForPlayback = WKAudiovisualMediaTypeNone;
    [config.userContentController addScriptMessageHandler:self name:kOpenHandlerName];
    [config.userContentController addScriptMessageHandler:self name:kSaveHandlerName];

    self.webView = [[WKWebView alloc] initWithFrame:self.view.bounds configuration:config];
    self.webView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;
    self.webView.opaque = NO;
    self.webView.backgroundColor = background;
    self.webView.scrollView.backgroundColor = background;
    // the page lays itself out around the notch and home bar with env(safe-area-inset-*) (viewport-fit=cover)
    self.webView.scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
    self.webView.scrollView.bounces = NO;
    [self.view addSubview:self.webView];

    self.loadingOverlay = [[UIView alloc] initWithFrame:self.view.bounds];
    self.loadingOverlay.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
    self.loadingOverlay.backgroundColor = background;
    UIActivityIndicatorView* spinner = [[UIActivityIndicatorView alloc] initWithActivityIndicatorStyle:UIActivityIndicatorViewStyleLarge];
    spinner.color = UIColor.whiteColor;
    spinner.center = self.loadingOverlay.center;
    spinner.autoresizingMask = UIViewAutoresizingFlexibleTopMargin | UIViewAutoresizingFlexibleBottomMargin |
                               UIViewAutoresizingFlexibleLeftMargin | UIViewAutoresizingFlexibleRightMargin;
    [spinner startAnimating];
    [self.loadingOverlay addSubview:spinner];
    [self.view addSubview:self.loadingOverlay];

    [self decideAboutTheDownloadThenStart];
}

- (UIStatusBarStyle)preferredStatusBarStyle {
    return UIStatusBarStyleLightContent;
}

#pragma mark - starting the backend (and asking before the catalog download uses mobile data)

// First launch downloads the card catalog (large). On a connection the system calls "expensive" (cellular, or a
// personal hotspot) ask first, like the Android app: download now, or wait for Wi-Fi. Otherwise just go.
- (void)decideAboutTheDownloadThenStart {
    if (!binder_ios::catalog_missing()) {
        [self startBackendWithDownload:YES];
        return;
    }
    self.monitor = nw_path_monitor_create();
    __weak BinderViewController* weakSelf = self;
    nw_path_monitor_set_update_handler(self.monitor, ^(nw_path_t path) {
        BOOL expensive = nw_path_is_expensive(path);
        BOOL online = nw_path_get_status(path) == nw_path_status_satisfied;
        dispatch_async(dispatch_get_main_queue(), ^{
            [weakSelf networkChanged:expensive online:online];
        });
    });
    nw_path_monitor_set_queue(self.monitor, dispatch_get_main_queue());
    nw_path_monitor_start(self.monitor);
    // the monitor reports straight away; if it somehow doesn't, don't leave the app blank
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        if (!weakSelf.started) [weakSelf startBackendWithDownload:YES];
    });
}

- (void)networkChanged:(BOOL)expensive online:(BOOL)online {
    if (!self.started) {
        if (expensive) {
            [self askAboutMobileData];
        } else {
            if (self.presentedViewController) [self dismissViewControllerAnimated:NO completion:nil];  // Wi-Fi arrived: no need to ask
            [self startBackendWithDownload:YES];
            [self stopMonitoring];
        }
        return;
    }
    // started with the download held back: it begins once we are on a connection that isn't expensive
    if (self.downloadHeld && online && !expensive) {
        self.downloadHeld = NO;
        binder_ios::start_download();
        [self stopMonitoring];
    }
}

- (void)stopMonitoring {
    if (self.monitor) {
        nw_path_monitor_cancel(self.monitor);
        self.monitor = nil;
    }
}

- (void)askAboutMobileData {
    if (self.presentedViewController) return;
    UIAlertController* alert = [UIAlertController
        alertControllerWithTitle:@"Download card data?"
                         message:@"Binder needs to download its card catalog before it can recognise cards. You're on mobile data "
                                 @"(or another connection that may be metered), so this may use a lot of data."
                  preferredStyle:UIAlertControllerStyleAlert];
    __weak BinderViewController* weakSelf = self;
    [alert addAction:[UIAlertAction actionWithTitle:@"Wait for Wi-Fi"
                                              style:UIAlertActionStyleCancel
                                            handler:^(UIAlertAction*) {
        if (weakSelf.started) return;
        weakSelf.downloadHeld = YES;
        [weakSelf startBackendWithDownload:NO];  // the monitor keeps running and starts the download on Wi-Fi
    }]];
    [alert addAction:[UIAlertAction actionWithTitle:@"Download now"
                                              style:UIAlertActionStyleDefault
                                            handler:^(UIAlertAction*) {
        if (weakSelf.started) return;
        [weakSelf startBackendWithDownload:YES];
        [weakSelf stopMonitoring];
    }]];
    [self presentViewController:alert animated:YES completion:nil];
}

- (void)startBackendWithDownload:(BOOL)downloadNow {
    if (self.started) return;
    self.started = YES;
    int port = binder_ios::start_backend(downloadNow);
    if (port <= 0) {
        self.loadingOverlay.hidden = YES;  // nothing to show; the reason is in the log
        return;
    }
    self.serverURL = [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%d/", port]];
    self.loadAttempts = 0;
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.serverURL]];
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView*)webView didFinishNavigation:(WKNavigation*)navigation {
    self.loadingOverlay.hidden = YES;
}

- (void)webView:(WKWebView*)webView didFailProvisionalNavigation:(WKNavigation*)navigation withError:(NSError*)error {
    // the server thread may not be accepting yet: retry rather than show a dead page
    if (++self.loadAttempts >= kMaxLoadRetries) return;
    __weak BinderViewController* weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kRetryDelay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        [weakSelf.webView loadRequest:[NSURLRequest requestWithURL:weakSelf.serverURL]];
    });
}

#pragma mark - WKUIDelegate

// The scan flow calls getUserMedia(); the system's camera prompt (NSCameraUsageDescription) is the real gate.
- (void)webView:(WKWebView*)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin*)origin
                          initiatedByFrame:(WKFrameInfo*)frame
                                      type:(WKMediaCaptureType)type
                           decisionHandler:(void (^)(WKPermissionDecision))decisionHandler API_AVAILABLE(ios(15.0)) {
    decisionHandler(WKPermissionDecisionGrant);
}

#pragma mark - WKScriptMessageHandler

// js/updates.js asks to open a download: this project's GitHub release pages and files only, handed to Safari.
// A collection's CSV export from the page: written to a temporary file and handed to the share sheet, from which it can
// be saved to Files, AirDropped, mailed and so on.
- (void)saveExport:(NSDictionary*)body {
    NSString* name = body[@"name"];
    NSString* text = body[@"text"];
    if (![name isKindOfClass:[NSString class]] || ![text isKindOfClass:[NSString class]]) return;
    if (name.length == 0 || name.length > 120 || ![name.lowercaseString hasSuffix:@".csv"] || [name hasPrefix:@"."]) return;
    if ([name rangeOfCharacterFromSet:[NSCharacterSet characterSetWithCharactersInString:@"/\\:*?\"<>|"]].location != NSNotFound) return;
    NSURL* file = [[NSURL fileURLWithPath:NSTemporaryDirectory()] URLByAppendingPathComponent:name];
    NSError* error = nil;
    if (![text writeToURL:file atomically:YES encoding:NSUTF8StringEncoding error:&error]) return;
    UIActivityViewController* share = [[UIActivityViewController alloc] initWithActivityItems:@[ file ] applicationActivities:nil];
    share.popoverPresentationController.sourceView = self.view;  // (iPad shows it as a popover)
    share.popoverPresentationController.sourceRect = CGRectMake(self.view.bounds.size.width / 2, self.view.bounds.size.height / 2, 1, 1);
    [self presentViewController:share animated:YES completion:nil];
}

- (void)userContentController:(WKUserContentController*)controller didReceiveScriptMessage:(WKScriptMessage*)message {
    if ([message.name isEqualToString:kSaveHandlerName]) {
        if ([message.body isKindOfClass:[NSDictionary class]]) [self saveExport:(NSDictionary*)message.body];
        return;
    }
    if (![message.name isEqualToString:kOpenHandlerName] || ![message.body isKindOfClass:[NSString class]]) return;
    NSString* urlString = (NSString*)message.body;
    if (![urlString hasPrefix:kReleasesPrefix] || urlString.length > 400) return;
    NSURL* url = [NSURL URLWithString:urlString];
    if (url) [UIApplication.sharedApplication openURL:url options:@{} completionHandler:nil];
}

@end
