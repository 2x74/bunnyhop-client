#include "music_envelope.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
int main(){
    native::MusicEnvelope envelope;assert(envelope.incoming()==1&&envelope.duck_gain==1);
    envelope.crossfade(3);assert(envelope.incoming()==0&&envelope.outgoing()==1);envelope.advance(1);assert(std::abs(envelope.incoming()-1.f/3)<1e-6);assert(std::abs(envelope.incoming()+envelope.outgoing()-1)<1e-6);
    envelope.advance(1,true);assert(std::abs(envelope.incoming()-1.f/3)<1e-6);envelope.advance(2);assert(!envelope.fading()&&envelope.incoming()==1);
    envelope.duck(.3f,1.2);envelope.advance(.18);assert(envelope.duck_gain>.3f&&envelope.duck_gain<.34f);envelope.advance(1.02);assert(envelope.duck_gain<.301f);envelope.advance(.5);assert(envelope.duck_gain>.73f&&envelope.duck_gain<.75f);envelope.advance(5);assert(envelope.duck_gain>.999f);
    envelope.duck(.1f,2);envelope.advance(.2);envelope.duck(.5f,1);envelope.advance(.2);assert(envelope.duck_gain>.45f&&envelope.duck_gain<.5f);
    const auto previous=envelope.duck_gain;envelope.advance(NAN);assert(envelope.duck_gain==previous);
}
