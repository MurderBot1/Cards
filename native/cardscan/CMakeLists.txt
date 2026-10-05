binder_use_json()

# Stage 1: just the engine interface + a "not available" engine, so the app can
# be wired up and tested end to end. The OpenCV/cardvec/cardnet-backed engine
# (the port of scanner.py) lands in this module next.
add_library(cardscan STATIC src/null_engine.cpp)
target_include_directories(cardscan PUBLIC include)
target_link_libraries(cardscan PUBLIC nlohmann_json::nlohmann_json)
