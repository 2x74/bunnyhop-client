#pragma once
#include <atomic>
#include <future>
#include <memory>
#include <vector>
#include <algorithm>
#include <stdexcept>
namespace native {
// Cancelled jobs retain their own token and future until they finish. A new
// request can start immediately; neither it nor a stale progress callback can
// accidentally revive a previous map load. Destruction cancels before joining.
template<class T> class MapJobs {
    struct Job {std::future<T> result;std::shared_ptr<std::atomic_bool> cancel;};
    Job active;
    std::vector<Job> retired;
public:
    ~MapJobs(){cancel();retired.clear();}
    bool valid()const{return active.result.valid();}
    template<class Rep,class Period> auto wait_for(const std::chrono::duration<Rep,Period> &span){return active.result.wait_for(span);}
    T get(){return active.result.get();}
    template<class F> void start(F load){
        if(valid())throw std::runtime_error("A map is already loading");
        auto token=std::make_shared<std::atomic_bool>(false);
        active={std::async(std::launch::async,[token,load=std::move(load)]{return load(*token);}),token};
    }
    void cancel(){
        if(active.cancel)*active.cancel=true;
        if(valid())retired.push_back(std::move(active));
        active={};
    }
    void poll(){std::erase_if(retired,[](auto &job){return job.result.wait_for(std::chrono::seconds(0))==std::future_status::ready;});}
};
}
