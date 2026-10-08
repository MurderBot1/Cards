#include "UrlSessionTransport.hpp"

#import <Foundation/Foundation.h>

// Writes the response body to a file as it arrives, and reports the size (Content-Length) once the headers are in.
@interface BinderDownload : NSObject <NSURLSessionDataDelegate>
@property(nonatomic, copy) NSString* path;
@property(nonatomic, copy) void (^sizeBlock)(unsigned long long);
@property(nonatomic, strong) NSFileHandle* file;
@property(nonatomic) long status;
@property(nonatomic) BOOL rejected;     // a non-2xx status: we cancel and just report the status
@property(nonatomic) BOOL writeFailed;
@property(nonatomic, strong) NSError* error;
@property(nonatomic, strong) dispatch_semaphore_t done;
@end

@implementation BinderDownload

- (void)URLSession:(NSURLSession*)session
          dataTask:(NSURLSessionDataTask*)task
didReceiveResponse:(NSURLResponse*)response
 completionHandler:(void (^)(NSURLSessionResponseDisposition))completionHandler {
    self.status = [response isKindOfClass:[NSHTTPURLResponse class]] ? ((NSHTTPURLResponse*)response).statusCode : 200;
    if (self.status < 200 || self.status >= 300) {
        self.rejected = YES;
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    [[NSFileManager defaultManager] createFileAtPath:self.path contents:nil attributes:nil];
    self.file = [NSFileHandle fileHandleForWritingAtPath:self.path];
    if (!self.file) {
        self.writeFailed = YES;
        completionHandler(NSURLSessionResponseCancel);
        return;
    }
    if (response.expectedContentLength > 0 && self.sizeBlock) self.sizeBlock((unsigned long long)response.expectedContentLength);
    completionHandler(NSURLSessionResponseAllow);
}

- (void)URLSession:(NSURLSession*)session dataTask:(NSURLSessionDataTask*)task didReceiveData:(NSData*)data {
    @try {
        [self.file writeData:data];
    } @catch (NSException* e) {  // disk full and the like
        self.writeFailed = YES;
        [task cancel];
    }
}

- (void)URLSession:(NSURLSession*)session task:(NSURLSessionTask*)task didCompleteWithError:(NSError*)error {
    self.error = error;
    @try {
        [self.file closeFile];
    } @catch (NSException* e) {
    }
    dispatch_semaphore_signal(self.done);
}

@end

namespace binder_ios {

cardfetch::Response UrlSessionTransport::get(const std::string&, int) {
    throw cardfetch::Error("UrlSessionTransport only supports downloads to a file");
}

long UrlSessionTransport::get_to_file(const std::string& url, int timeout_seconds, const std::filesystem::path& dest) {
    @autoreleasepool {
        NSURL* nsurl = [NSURL URLWithString:[NSString stringWithUTF8String:url.c_str()]];
        if (!nsurl) throw cardfetch::Error("not a valid URL: " + url);
        std::error_code ec;
        if (dest.has_parent_path()) std::filesystem::create_directories(dest.parent_path(), ec);
        std::filesystem::remove(dest, ec);

        auto size_callback = on_download_size;  // copied: the transport may change it once we return
        BinderDownload* download = [[BinderDownload alloc] init];
        download.path = [NSString stringWithUTF8String:dest.c_str()];
        download.done = dispatch_semaphore_create(0);
        download.sizeBlock = ^(unsigned long long bytes) {
            if (size_callback) size_callback(bytes);
        };

        NSURLSessionConfiguration* config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
        // like libcurl's low-speed limit: bounds connecting and a stalled transfer, not the whole (large) download
        config.timeoutIntervalForRequest = timeout_seconds;
        config.timeoutIntervalForResource = 24 * 60 * 60;
        NSOperationQueue* queue = [[NSOperationQueue alloc] init];
        queue.maxConcurrentOperationCount = 1;
        NSURLSession* session = [NSURLSession sessionWithConfiguration:config delegate:download delegateQueue:queue];

        NSMutableURLRequest* request = [NSMutableURLRequest requestWithURL:nsurl];
        [request setValue:[NSString stringWithUTF8String:cardfetch::kUserAgent] forHTTPHeaderField:@"User-Agent"];
        [[session dataTaskWithRequest:request] resume];
        dispatch_semaphore_wait(download.done, DISPATCH_TIME_FOREVER);
        [session finishTasksAndInvalidate];

        if (download.rejected) {  // HTTP error: no file, just the status
            std::filesystem::remove(dest, ec);
            return download.status;
        }
        if (download.writeFailed || download.error) {
            std::filesystem::remove(dest, ec);
            std::string reason = download.writeFailed ? "could not write " + dest.string()
                                                      : std::string(download.error.localizedDescription.UTF8String);
            throw cardfetch::Error("request to " + url + " failed: " + reason);
        }
        return download.status;
    }
}

}  // namespace binder_ios
