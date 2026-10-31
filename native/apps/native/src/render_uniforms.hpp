#pragma once

class RenderDepthProgram {
    gfx::Context &context;
    gfx::ConstantBinding viewConstants, modelConstants;

    struct ViewValues {
        native::Matrix projection{};
        float clipHeight = gfx::no_clip_height;
    } viewValues;

    struct ModelValues {
        native::Matrix model{};
        float cutoff = 0;
    } modelValues;

public:
    gfx::Program program;

    explicit RenderDepthProgram(gfx::Context &graphics) : context(graphics) {}

    ~RenderDepthProgram() {
        context.destroy(viewConstants);
        context.destroy(modelConstants);
        context.destroy(program);
    }

    void prepare_constants() {
        static constexpr gfx::ConstantField viewFields[] = {
                {"viewProjection", offsetof(ViewValues, projection), 64, gfx::ConstantType::matrix4},
                {"clipHeight", offsetof(ViewValues, clipHeight), 4, gfx::ConstantType::float1},
        };
        static constexpr gfx::ConstantField modelFields[] = {
                {"model", offsetof(ModelValues, model), 64, gfx::ConstantType::matrix4},
                {"cutoff", offsetof(ModelValues, cutoff), 4, gfx::ConstantType::float1},
        };
        viewConstants = context.create_constants(program, {viewFields, sizeof(ViewValues)});
        modelConstants = context.create_constants(program, {modelFields, sizeof(ModelValues)});
    }

    void bind(const native::Matrix &projection, float clipHeight = gfx::no_clip_height) {
        viewValues = {projection, clipHeight};
        context.bind_program(program);
        context.constants(viewConstants, &viewValues);
    }

    void model(const native::Matrix &matrix, float cutoff = 0) {
        modelValues = {matrix, cutoff};
        context.constants(modelConstants, &modelValues);
    }
};
