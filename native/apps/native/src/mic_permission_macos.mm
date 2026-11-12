#include "mic_permission.hpp"
#import <AVFoundation/AVFoundation.h>

namespace native {

MicAccess mic_access() {
    switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio]) {
    case AVAuthorizationStatusAuthorized:
        return MicAccess::granted;
    case AVAuthorizationStatusNotDetermined:
        return MicAccess::undetermined;
    default:
        return MicAccess::denied;
    }
}

void request_mic_access(std::function<void(bool granted)> done) {
    auto callback = std::make_shared<std::function<void(bool)>>(std::move(done));
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
                                 (*callback)(granted == YES);
                             }];
}

} // namespace native
